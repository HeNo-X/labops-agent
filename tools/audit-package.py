#!/usr/bin/env python3
"""发布包审计器：对 zip 或目录做敏感项与体积审计，命中即失败。

打包脚本的过滤规则不等于真的过滤了：手工 zip 会绕过 tools/package-labops-agent.py
的拒绝清单，可能把 .env、.git/、server/credentials/business.key 一起打进
"全量源码分享包"。因此必须对**最终产物**独立复核。

打包脚本直接复用本文件的 classify() 与 scan_content()，保证两处口径一致；后者另含
内容级扫描（防真 Key 写进 .env.example 这类"模板文件"随包外发）。

用法：
    python tools/audit-package.py <文件或目录> [--max-mb 100] [--allow 路径前缀]...
退出码：0 = 通过；1 = 命中禁止项或超体积；2 = 输入不可用。
"""
import argparse
from hashlib import sha256
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

# 目录段：出现即判为构建产物/仓库元数据，不该进发布包
FORBIDDEN_PARTS = {
    ".git", "node_modules", "dist", "target", ".gradle", "__pycache__",
    "data-backups", ".venv", "venv", ".idea", ".vscode",
}
FORBIDDEN_PREFIXES = (".review-data", ".review-shots", ".screenshots", ".workbuddy", ".qoder", ".evaluation")

# 文件名：凭据与运行数据
FORBIDDEN_NAMES = {
    ".env", ".env.local", ".env.production", "credentials.json", "sessions.json",
    "state.json", "id_rsa", "id_ed25519",
}
# 文件名后缀：密钥、数据库、证书、备份、构建中间产物、未脱敏中间产物
FORBIDDEN_SUFFIXES = (
    ".key", ".pem", ".p12", ".pfx", ".keystore", ".jks", ".crt", ".der",
    ".sqlite", ".sqlite-wal", ".sqlite-shm", ".db", ".db-wal", ".db-shm",
    ".bak", ".pyc", ".tsbuildinfo", ".log", ".skill",
    ".raw.json", ".unredacted.json",
)
# 路径前缀：本项目已知的凭据落点与运行时数据落点（与 .gitignore 同一口径：
# 运行时数据——会话/业务数据/视觉事件流水——绝不进发布包）
FORBIDDEN_PATH_PREFIXES = (
    "server/credentials/", "credentials/", "Pages/data/", "Pages/lib/data/",
    "server/data/",
)

# 内容级扫描：真 Key 一旦写进 .env.example / 文档 / 注释，就会随包公开外发
SECRET_PATTERNS = (
    ("dashscope-key", re.compile(r"sk-[A-Za-z0-9_\-]{16,}")),
    ("pem-private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("aws-access-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("generic-long-secret", re.compile(
        r"(?i)\b(?:api[_-]?key|secret|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['\"]?([A-Za-z0-9+/_\-]{28,})['\"]?(?=\s|$)"
    )),
)
CONTENT_SCAN_MAX_BYTES = 2 * 1024 * 1024  # 只扫小文件，避免在二进制/大资源上浪费时间


def classify(rel: str) -> str | None:
    """返回命中的类别，未命中返回 None。"""
    p = PurePosixPath(rel)
    lowered = [part.lower() for part in p.parts]
    if any(part in FORBIDDEN_PARTS for part in lowered):
        return "forbidden-dir"
    if any(part.startswith(FORBIDDEN_PREFIXES) for part in lowered):
        return "forbidden-dir"
    norm = "/".join(lowered)
    if norm.startswith(FORBIDDEN_PATH_PREFIXES) or any(
        ("/" + seg) in ("/" + norm) for seg in FORBIDDEN_PATH_PREFIXES
    ):
        return "forbidden-credentials-path"
    if p.name.lower() in FORBIDDEN_NAMES:
        return "forbidden-name"
    if p.name.lower().endswith(FORBIDDEN_SUFFIXES):
        return "forbidden-suffix"
    return None


def scan_content(rel: str, data: bytes) -> list[str]:
    if len(data) > CONTENT_SCAN_MAX_BYTES or b"\x00" in data[:4096]:
        return []
    text = data.decode("utf-8", errors="ignore")
    hits = []
    for label, pattern in SECRET_PATTERNS:
        match = pattern.search(text)
        if match:
            line = text[: match.start()].count("\n") + 1
            hits.append(f"{label}@line{line}")
    return hits


def entries_of(target: Path):
    """产出 (相对路径, 字节读取器) 序列。zip 与目录统一处理。"""
    if target.is_file():
        with zipfile.ZipFile(target) as z:
            if z.testzip() is not None:
                raise ValueError("压缩包 CRC 校验失败，包已损坏")
            for name in z.namelist():
                if not name.endswith("/"):
                    yield name, z.read(name), z.getinfo(name).file_size
    elif target.is_dir():
        for path in sorted(target.rglob("*")):
            if path.is_file():
                rel = path.relative_to(target).as_posix()
                yield rel, path.read_bytes(), path.stat().st_size
    else:
        raise FileNotFoundError(target)


def strip_root(rel: str) -> str:
    """忽略包内顶层目录名，让规则对 labops-agent/xxx 与 xxx 表现一致。"""
    parts = PurePosixPath(rel).parts
    return "/".join(parts[1:]) if len(parts) > 1 else rel


def audit(target: Path, max_mb: float, allow: tuple[str, ...]):
    limit = int(max_mb * 1024 * 1024)
    findings: list[dict] = []
    files = 0
    total = 0
    biggest = ("", 0)
    digest = sha256()

    for rel, data, size in entries_of(target):
        files += 1
        total += size
        digest.update(rel.encode())
        digest.update(b"\0")
        digest.update(data)
        if size > biggest[1]:
            biggest = (rel, size)
        if size > limit:
            findings.append({"kind": "oversize-file", "path": rel, "bytes": size})
        if any(rel.replace("\\", "/").startswith(a) for a in allow):
            continue
        reason = classify(strip_root(rel)) or classify(rel)
        if reason:
            findings.append({"kind": reason, "path": rel, "bytes": size})
            continue
        for hit in scan_content(strip_root(rel), data):
            findings.append({"kind": "secret-in-content", "path": rel, "detail": hit, "bytes": size})

    if total > limit:
        findings.append({"kind": "oversize-total", "path": "(整包)", "bytes": total})

    return {
        "target": str(target),
        "files": files,
        "totalBytes": total,
        "totalMB": round(total / 1048576, 2),
        "largestFile": {"path": biggest[0], "bytes": biggest[1]},
        "manifestSha256": digest.hexdigest(),
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="作品包敏感项与体积审计")
    parser.add_argument("target", type=Path, help="待审计的 zip 文件或目录")
    parser.add_argument("--max-mb", type=float, default=100.0, help="单文件与整包上限（MB），默认 100")
    parser.add_argument("--allow", action="append", default=[], help="放行指定路径前缀，可重复")
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    args = parser.parse_args()

    # Windows 控制台默认 GBK，中文报告与路径会乱码
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    try:
        report = audit(args.target.resolve(), args.max_mb, tuple(a.replace("\\", "/") for a in args.allow))
    except (FileNotFoundError, zipfile.BadZipFile, ValueError) as error:
        print(f"审计无法执行：{error}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        kinds = {}
        for item in report["findings"]:
            kinds.setdefault(item["kind"], []).append(item)
        print(f"审计对象：{report['target']}")
        print(f"文件数：{report['files']}   总体积：{report['totalMB']} MB   "
              f"最大单文件：{report['largestFile']['path'] or '(空)'} "
              f"({round(report['largestFile']['bytes'] / 1048576, 2)} MB)")
        print(f"内容指纹：{report['manifestSha256'][:16]}…")
        if not report["findings"]:
            print("结论：通过 —— 未发现敏感项，体积在上限内。")
        else:
            print(f"结论：不通过 —— 命中 {len(report['findings'])} 项：")
            for kind, items in sorted(kinds.items()):
                print(f"  [{kind}] {len(items)} 项")
                for item in items[:12]:
                    detail = f" ({item['detail']})" if item.get("detail") else ""
                    print(f"      - {item['path']}{detail}")
                if len(items) > 12:
                    print(f"      … 另有 {len(items) - 12} 项")
    return 1 if report["findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
