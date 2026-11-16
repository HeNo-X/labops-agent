#!/usr/bin/env python3
"""LabOps Agent 发布包打包器 —— 唯一允许的打包路径。

打包脚本的排除规则不等于真的排除了：手工 zip 绕过了任何审计，就可能把 `.env`、
`.git/`、`server/credentials/business.key` 一并打进去。本脚本用 audit-package.py 的
同一套规则**在写入前过滤、写入后复核**，并产出可复现的清单，使"打包"这件事只有一条
受审计的路径可走。

复现性：固定时间戳与权限位，源码不变则两次产出的 zip 字节一致（复验、版本比对都用得上）。

用法：
    python tools/package-labops-agent.py --out <仓库外目录> [--allow-dirty] [--label TAG]

本脚本与 audit-package.py 随仓库分发，使仓库自包含（clone 后 npm run pack:submit 直接可用）。
打包对象 = 本仓根。
"""
import argparse
from datetime import datetime
from hashlib import sha256
import importlib.util
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
AGENT = ROOT
sys.path.insert(0, str(HERE))

_spec = importlib.util.spec_from_file_location("audit_package", HERE / "audit-package.py")
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

# 固定时间戳保证可复现；取项目发布日，非文件系统时间
ZIP_TIMESTAMP = (2026, 11, 1, 0, 0, 0)
FILE_MODE = 0o100644 << 16
MAX_MB = 100.0  # 单文件 100MB 上限
WARN_AT_MB = 60.0
# 工作区脏文件数超过此值时，说明有在途改动未冻结，默认拒绝打包
DIRTY_LIMIT = 0


def digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def git(*args: str) -> str:
    return subprocess.run(
        ("git", *args), cwd=AGENT, capture_output=True, text=True, encoding="utf-8"
    ).stdout.strip()


def assert_reproducible_source(allow_dirty: bool) -> dict:
    """发布包必须对应一个明确的代码状态，否则"可复现"只是口号。"""
    if not (AGENT / ".git").is_dir():
        raise SystemExit("labops-agent 不是 git 仓库，无法确定代码状态")
    dirty = [line for line in git("status", "--porcelain").splitlines() if line.strip()]
    head = git("rev-parse", "--short", "HEAD")
    commits = git("rev-list", "--count", "HEAD")
    # 用 commit 时间而非打包时刻：源码不变则清单不变，包才可复现
    commit_date = git("log", "-1", "--format=%cI", "HEAD")
    state = {
        "head": head,
        "commits": int(commits) if commits.isdigit() else None,
        "dirtyFiles": len(dirty),
        "commitDate": commit_date,
    }
    if dirty and not allow_dirty:
        print(f"工作区有 {len(dirty)} 个未提交文件，代码状态无法对应明确 commit：", file=sys.stderr)
        for line in dirty[:10]:
            print("   " + line, file=sys.stderr)
        if len(dirty) > 10:
            print(f"   … 另有 {len(dirty) - 10} 个", file=sys.stderr)
        print("先按模块拆分提交，或确认要打包在途状态时加 --allow-dirty。", file=sys.stderr)
        raise SystemExit(1)
    if len(dirty) > DIRTY_LIMIT and allow_dirty:
        print(f"⚠ 已放行 {len(dirty)} 个未提交文件，包内代码状态不对应任何 commit。")
    return state


def collect() -> dict[str, bytes]:
    """遍历源目录，按审计规则**在写入前**过滤。"""
    if not AGENT.is_dir():
        raise SystemExit(f"找不到源目录：{AGENT}")
    kept: dict[str, bytes] = {}
    dropped: dict[str, int] = {}
    for path in sorted(AGENT.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(AGENT).as_posix()
        reason = audit.classify(rel)
        if reason:
            dropped[reason] = dropped.get(reason, 0) + 1
            continue
        data = path.read_bytes()
        hits = audit.scan_content(rel, data)
        if hits:
            # 内容级命中不能静默跳过——多半是 Key 写进了模板或文档，必须人工处置
            raise SystemExit(f"敏感内容拦截：{rel} → {', '.join(hits)}。请清空真值后重试。")
        kept["labops-agent/" + rel] = data
    return {"kept": kept, "dropped": dropped}


def build(entries: dict[str, bytes], prefix: str) -> bytes:
    import io

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in sorted(entries):
            info = zipfile.ZipInfo(prefix + "/" + name[len("labops-agent/"):], ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = FILE_MODE
            z.writestr(info, entries[name], compresslevel=9)
    return buffer.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description="LabOps Agent 作品包打包器")
    parser.add_argument("--out", type=Path, default=None, help="输出目录（必须在仓库外）")
    parser.add_argument("--label", default="", help="包名附加标记")
    parser.add_argument("--allow-dirty", action="store_true", help="允许打包未提交的工作区状态")
    parser.add_argument("--name", default="Qizhen-LabOps-Agent", help="包名前缀")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    if args.out is None:
        raise SystemExit("必须用 --out 指定输出目录，且必须在仓库之外（如 --out ../submit-packages）")
    out = args.out.resolve()
    if out == ROOT or ROOT in out.parents:
        raise SystemExit("输出目录必须在项目仓库之外，避免被再次打进包里")

    state = assert_reproducible_source(args.allow_dirty)
    collected = collect()
    entries = collected["kept"]

    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    label = ("-" + args.label) if args.label else ""
    manifest = {
        "package": f"{args.name}{label}",
        "generatedAtCommit": state["commitDate"],
        "sourceRepo": "labops-agent (独立 git 仓库)",
        "sourceHead": state["head"],
        "sourceCommits": state["commits"],
        "uncommittedFilesAtBuild": state["dirtyFiles"],
        "fileCount": len(entries),
        "droppedByRule": collected["dropped"],
        "reproducible": state["dirtyFiles"] == 0,
        "howToRun": "解压后读 labops-agent/README.md；离线演示执行 npm ci && npm run demo",
        "files": [{"path": n, "sha256": digest(d), "bytes": len(d)} for n, d in sorted(entries.items())],
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    entries[f"{args.name}{label}-MANIFEST.json"] = manifest_bytes

    blob = build(entries, args.name + label)
    size_mb = len(blob) / 1048576
    if size_mb > MAX_MB:
        raise SystemExit(f"产出 {size_mb:.2f} MB，超过官方 {MAX_MB} MB 上限，不予输出")

    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{args.name}{label}-{state['head']}-{stamp}.zip"
    target.write_bytes(blob)

    largest = max(entries.items(), key=lambda kv: len(kv[1]))
    print(f"产出：{target}")
    print(f"文件数：{len(entries)}   体积：{size_mb:.2f} MB   "
          f"最大单文件：{PurePosixPath(largest[0]).name} ({len(largest[1]) / 1048576:.2f} MB)")
    print(f"代码状态：HEAD {state['head']} / {state['commits']} commits / "
          f"未提交 {state['dirtyFiles']} 个")
    print(f"按规则排除：{collected['dropped'] or '无'}")
    print(f"包指纹：{digest(blob)[:16]}…")
    if size_mb > WARN_AT_MB:
        print(f"⚠ 已用掉官方 100MB 上限的 {size_mb / MAX_MB * 100:.0f}%，加演示物料前留意余量。")

    # 写入后复核：过滤逻辑有 bug 也要在这里被拦住，而不是等打包后才发现
    rc = subprocess.run(
        (sys.executable, str(HERE / "audit-package.py"), str(target), "--max-mb", str(MAX_MB)),
        capture_output=True, text=True, encoding="utf-8",
    )
    print("---- 产物复核 ----")
    print(rc.stdout.strip())
    if rc.returncode != 0:
        target.unlink(missing_ok=True)
        print("复核未通过，已删除产出。", file=sys.stderr)
        return 1
    print("复核通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
