/** Interact with the public 0.7 sidebar instead of the removed top connection strip. */
export async function revealSidebar(page){
 if(page.viewportSize().width<=900&&!(await page.locator('.agent-sidebar').getAttribute('class')).includes('is-open'))await page.locator('.chat__navtoggle').click();
}
export async function showConnections(page){
 await revealSidebar(page);
 if(!await page.locator('.sidebar-account-menu').count())await page.getByRole('button',{name:'账户与设置',exact:true}).click();
 if(!await page.locator('.business-panel').count())await page.getByRole('button',{name:'连接与模型',exact:true}).click();
}
export async function closeSettings(page){
 if(await page.locator('.settings-dialog').count())await page.getByRole('button',{name:'返回工作区',exact:true}).click();
 if(await page.locator('.sidebar-account-menu').count())await page.getByRole('button',{name:'关闭账户设置',exact:true}).click();
 if(page.viewportSize().width<=900)await page.keyboard.press('Escape');
}
/** 批2：业务入口从侧栏迁到 设置→工作；以下助手走新路径（点击入口后面板打开、设置自动关闭） */
export async function openWorkSettings(page){
 await revealSidebar(page);
 if(!await page.locator('.settings-dialog').count()){
  if(!await page.locator('.sidebar-account-menu').count())await page.getByRole('button',{name:'账户与设置',exact:true}).click();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.locator('.settings-dialog').waitFor();
 }
 await page.getByRole('tab',{name:'工作',exact:true}).click();
}
export async function openWork(page){
 await openWorkSettings(page);
 await page.locator('.settings-dialog').getByRole('button',{name:'我的工作',exact:true}).click();
 await page.locator('.native-work-mask').waitFor();
}
export async function openIncident(page){
 await openWorkSettings(page);
 await page.locator('.settings-dialog').getByRole('button',{name:'登记故障事件',exact:true}).click();
 await page.locator('.native-work-mask').waitFor();
}
