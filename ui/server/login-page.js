// Sign-in page served by the server itself (no app bundle before login, AC 2). The same page also asks for a new
// password when the account still has to change it (AC 4). Plain HTML, inline style and script, no outside files.
// Same mark as client/src/components/brand-mark.jsx, in the page's accent color.
const MARK = '<svg viewBox="0 0 64 64" aria-hidden="true"><ellipse cx="32" cy="37" rx="27" ry="9" transform="rotate(-16 32 37)" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="2.6"/><path d="M32 12 L15 51 M32 12 L49 51 M23 38 H41" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="12" r="5" fill="currentColor"/><circle cx="15" cy="51" r="5.4" fill="currentColor"/><circle cx="49" cy="51" r="5.4" fill="currentColor"/></svg>';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function loginPage({ mustChange = false, user = 'administrator', minLength = 8 } = {}) {
  const form = mustChange
    ? `<h1>Set a new password</h1>
      <p class="sub">First sign-in: choose your own password before Artrios opens.</p>
      <form id="f" data-kind="change">
        <label>Current password<input name="current" type="password" autocomplete="current-password" required autofocus></label>
        <label>New password<input name="next" type="password" autocomplete="new-password" minlength="${minLength}" required></label>
        <label>Repeat new password<input name="again" type="password" autocomplete="new-password" minlength="${minLength}" required></label>
        <p class="hint">At least ${minLength} characters.</p>
        <button type="submit">Save and open</button>
        <p id="msg" role="alert"></p>
      </form>
      <form id="out" class="link"><button type="submit">Sign out</button></form>`
    : `<h1>Sign in</h1>
      <p class="sub">Artrios on this computer.</p>
      <form id="f" data-kind="login">
        <label>User<input name="name" value="${esc(user)}" autocomplete="username" readonly></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
        <button type="submit">Sign in</button>
        <p id="msg" role="alert"></p>
      </form>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Artrios sign in</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
/* Same tokens as client/src/styles.css (light and dark). */
:root{--bg:#d9e0ea;--card:#e6ebf3;--fg:#0d1526;--muted:#4a566d;--line:rgb(13 21 38 / 14%);--accent:#0369a1;--accent-fg:#fff;--bad:#be123c}
@media (prefers-color-scheme:dark){:root{--bg:#05070d;--card:#0b1020;--fg:#e8ecf4;--muted:#8b94a8;--line:rgb(255 255 255 / 8%);--accent:#38bdf8;--accent-fg:#05070d;--bad:#fb7185}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em;color:var(--accent);font-size:13px;text-transform:uppercase;margin:0 0 14px}
.brand svg{width:30px;height:30px;filter:drop-shadow(0 0 8px var(--accent))}
h1{font-size:20px;margin:0 0 4px}.sub{margin:0 0 20px;color:var(--muted);font-size:13px}
form{display:grid;gap:12px}label{display:grid;gap:4px;font-size:13px;font-weight:500}
input{font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
input[readonly]{color:var(--muted)}input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;font-weight:600;padding:10px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-fg);cursor:pointer}
button:disabled{opacity:.6;cursor:wait}.hint{margin:-4px 0 0;color:var(--muted);font-size:12px}
#msg{margin:0;min-height:1.2em;color:var(--bad);font-size:13px}
.link{margin-top:14px}.link button{background:none;color:var(--muted);font-weight:500;padding:4px;text-decoration:underline}
</style></head>
<body><main><p class="brand">${MARK}Artrios</p>${form}</main>
<script>
const f=document.getElementById('f'),msg=document.getElementById('msg');
const post=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});
f.addEventListener('submit',async(e)=>{e.preventDefault();msg.textContent='';const d=Object.fromEntries(new FormData(f));
if(f.dataset.kind==='change'&&d.next!==d.again){msg.textContent='The two new passwords differ.';return}
const b=f.querySelector('button');b.disabled=true;
try{const r=f.dataset.kind==='login'?await post('/api/auth/login',{name:d.name,password:d.password}):await post('/api/auth/password',{current:d.current,next:d.next});
const j=await r.json().catch(()=>({}));if(r.ok){location.reload();return}msg.textContent=j.error||('Error '+r.status)}
catch{msg.textContent='The server did not answer.'}b.disabled=false});
const out=document.getElementById('out');if(out)out.addEventListener('submit',async(e)=>{e.preventDefault();await post('/api/auth/logout',{});location.reload()});
</script></body></html>`;
}
