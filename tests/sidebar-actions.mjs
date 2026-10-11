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
 if(await page.locator('.settings-dialog').count())await page.getByRole('button',{name:'关闭设置',exact:true}).click();
 if(await page.locator('.sidebar-account-menu').count())await page.getByRole('button',{name:'关闭账户设置',exact:true}).click();
 if(page.viewportSize().width<=900)await page.keyboard.press('Escape');
}
