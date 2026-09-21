import { expect, test, type Page } from '@playwright/test';

/** The shared E2E server retains the real 10/minute login guard; tests do not disable it. */
export async function submitLogin(page:Page,role:'管理者'|'閲覧者'):Promise<void>{
  for(let attempt=0;attempt<2;attempt++){
    const response=page.waitForResponse(r=>r.url().endsWith('/v1/auth/login')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'ログイン',exact:true}).click();const result=await response;
    const body=await result.json() as {code?:string};
    if(result.status()===429&&body.code==='LOGIN_RATE_LIMIT'&&attempt===0){
      // This is a bounded, explicit retry after the existing server's 60s window, not a weakened assertion.
      test.setTimeout(test.info().timeout+65000);await page.waitForTimeout(61000);continue;
    }
    expect(result.status(),body.code??'login response').toBe(200);
    await expect(page.locator('.workspace-role')).toHaveText(role);return;
  }
  throw new Error('LOGIN_DID_NOT_COMPLETE');
}
