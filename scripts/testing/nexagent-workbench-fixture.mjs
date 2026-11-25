// Additional design capabilities, installed only on an isolated --workbench smoke Core.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import {promisify} from "node:util";
import {mkdir,writeFile} from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";


export async function installWorkbench({ core, api, dirs, deviceId, ids, bootstrap, email, password }) {
  const records = Object.create(null);
  const checkouts = Object.create(null);
  const attempts = new Map();
  const git = (cwd,args) => execFileSync("git",["-C",cwd,"-c","core.hooksPath="+path.join(dirs.home,"empty-hooks"),...args],{
    windowsHide:true, encoding:"utf8",timeout:15000,
    env:{...process.env,GIT_CONFIG_GLOBAL:path.join(dirs.home,"empty-global.gitconfig"),GIT_CONFIG_NOSYSTEM:"1"}
  }).trim();
  for(const name of ["alpha","beta","gamma"]){
    const cwd=path.join(dirs.work,name);
    mkdirSync(cwd,{recursive:true});
    git(cwd,["init","-b","main"]);
    if(name==="alpha"){
      writeFileSync(path.join(cwd,"session.md"),"# NexAgent\n","utf8");
      git(cwd,["add","--","session.md"]);
    }
    git(cwd,["-c","user.name=Preview","-c","user.email=preview@example.test","-c","commit.gpgsign=false","commit","--allow-empty","-m","Initialize review fixture"]);
    if(name==="alpha")writeFileSync(path.join(cwd,"session.md"),"# NexAgent\n\n设备、项目与会话导航。\n","utf8");
    checkouts[cwd]={project:cwd,worktree:cwd,branch:"main"};
  }
  const keyFor = (id) => deviceId + ":claude:" + id;
  const root = keyFor(ids.alphaOne);
  const child = keyFor(ids.alphaTwo);
  const leaf = keyFor("d1111111-1111-4111-8111-111111111111");
  const configure = (key, values) => Object.assign(records[key] ??= {}, values);
  configure(root, {title:"NexAgent 远程接手会话方案", model:"Sonnet"});
  configure(child, {title:"目录树与分支排序",parent:root});
  configure(leaf, {title:"验证孙会话边界",parent:child});
  const resumed = await api("cli-agents/continue", {key:root});
  const initial = resumed.key;
  if (initial !== root) {configure(initial,{...records[root]});configure(root,{archived:true});records[child].parent=initial}
  const timers = new Map();
  const pending = new Map();
  let serial = Promise.resolve();
  const state = () => ({ initial, records, checkouts, renameSessions:true, gitInspector:true, fileUpload:true, skills:["/review","/plan","/test"], models:{claude:["Sonnet","Opus"],codex:["GPT","GPT mini"],zcode:["GLM"]} });
  const list = async () => (await api("cli-agents")).sessions;
  const locate = async (key) => {
    const s = (await list()).find(r=>r.key===key && r.deviceId===deviceId);
    if(!s || records[key]?.deleted) throw Error("当前会话不可用");
    return s;
  };
  const readGit=promisify(execFile);
  async function gitInfo(key) {
    const session=await locate(key);
    const checkout=checkouts[session.cwd];
    if(!checkout)throw Error("当前目录没有 Git 信息");
    const run=async(args)=>(await readGit("git",["--no-optional-locks","-C",checkout.worktree,...args],{
      windowsHide:true,encoding:"utf8",timeout:4000,maxBuffer:1024*1024,
      env:{...process.env,GIT_CONFIG_GLOBAL:path.join(dirs.home,"empty-global.gitconfig"),GIT_CONFIG_NOSYSTEM:"1"}
    })).stdout;
    const [head,branch,changes,stats]=await Promise.all([
      run(["rev-parse","--short","HEAD"]),run(["branch","--show-current"]),
      run(["status","--porcelain=v1","--no-renames","-z","--untracked-files=all"]),
      run(["diff","--no-ext-diff","--no-textconv","--no-renames","--numstat","-z","HEAD","--"])
    ]);
    let added=0,removed=0;
    for(const line of stats.split("\0")){
      const m=/^(\d+)\t(\d+)\t/.exec(line);
      if(m){added+=Number(m[1]);removed+=Number(m[2])}
    }
    return {...checkout,branch:branch.trim()||"分离 HEAD",head:head.trim(),added,removed,
      files:changes.split("\0").filter(Boolean).map(entry=>entry.slice(3))};
  }
  async function startWorktree(data) {
    const checkout=checkouts[data.cwd];
    if(!checkout || data.deviceId!==deviceId || data.engine!=="claude")throw Error("请选择此测试设备的 Git 工作目录和可用运行工具");
    const branch=String(data.branch||"").trim();
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,95}$/.test(branch))throw Error("请输入有效的 Git 分支名");
    try{git(data.cwd,["check-ref-format","--branch",branch])}catch{throw Error("请输入有效的 Git 分支名")}
    const requestId=String(data.requestId||"");if(!/^[a-f0-9-]{36}$/.test(requestId))throw Error("无效的创建请求");
    const identity=JSON.stringify([data.cwd,branch,data.engine]);
    let attempt=attempts.get(requestId);
    if(attempt&&attempt.identity!==identity)throw Error("工作目录或分支已变化，请重试");
    if(!attempt){
      const parent=path.join(dirs.work,"worktrees",path.basename(checkout.project));
      mkdirSync(parent,{recursive:true});
      const target=path.join(parent,branch.replaceAll("/","-")+"-"+requestId.slice(0,8));
      try{git(data.cwd,["worktree","add","-b",branch,target,"HEAD"])}catch{throw Error("无法创建工作树，请检查分支名是否已存在")}
      checkouts[target]={project:checkout.project,worktree:target,branch};
      attempt={identity,target};attempts.set(requestId,attempt);
    }
    if(!attempt.key)attempt.key=(await api("cli-agents/start",{deviceId,engine:data.engine,cwd:attempt.target})).key;
    configure(attempt.key,{title:branch});
    return {key:attempt.key};

  }
  async function action(data) {
    if(data.action==="worktree-start")return startWorktree(data);
    const key=data.key, s=await locate(key), rec=configure(key,{});
    switch(data.action) {
      case "rename": {
        const title=typeof data.title==="string"?data.title.trim():"";
        if(!title || title.length>200)throw Error("会话名称须为 1 至 200 个字符");
        rec.title=title;return {};
      }
      case "quoted-send": {
        if(typeof data.text!=="string"||!data.text.trim())throw Error("消息不能为空");
        const text=rec.quote&&!rec.quoteSent?"引用「"+rec.quote+"」\n\n"+data.text:data.text;
        await api("cli-agents/send",{key,text});rec.quoteSent=true;return {};
      }
      case "fork": case "side": {
        const fork=data.action==="fork";
        if (fork && (rec.kind==="side" || (rec.parent && records[rec.parent]?.parent))) throw Error("已达到分支层级上限");
        if(s.engine!=="claude")throw Error("此夹具仅提供 Claude 替身");
        const title=String(data.title||"").trim();
        if(!title)throw Error("请输入会话名称");
        const quote=typeof data.quote==="string"?data.quote.trim():"";
        if(quote.length>16000)throw Error("选区过长，请缩短后重试");
        const history=fork?(await api("cli-agents/items?key="+encodeURIComponent(key))).items:[];
        const created=await api("cli-agents/start",{deviceId,engine:s.engine,cwd:s.cwd});
        configure(created.key,{title,parent:!fork&&rec.kind==="side"?rec.parent:key,sourceKey:key,sourceMessage:data.message,quote,kind:fork?"fork":"side",history:fork?[...(rec.history||[]),...history]:[],model:rec.model||"Sonnet"});
        return {key:created.key};
      }
      case "archive":rec.archived=true;return {};
      case "restore":rec.archived=false;return {};
      case "delete":rec.deleted=true;rec.queue=[];for(const item of Object.values(records))if(item.parent===key && item.kind!=="side")item.parent=rec.parent;return {};
      case "settings":if(!state().models[s.engine].includes(data.model))throw Error("未知模型");rec.model=data.model;rec.effort=data.effort==="高"?"高":"标准";return {};
      case "unqueue":rec.queue=(rec.queue||[]).filter(q=>q.id!==data.id);return {};
      case "queue":case "steer": {
        if(typeof data.text!=="string"||!data.text.trim())throw Error("消息不能为空");
        if(data.action==="steer"){await api("cli-agents/send",{key,text:data.text});return {}}
        (rec.queue??=[]).push({id:randomUUID(),text:data.text});
        if(!timers.has(key)){
          const timer=setInterval(async()=>{
            if(pending.has(key))return;
            pending.set(key,true);
            try{
              if(rec.archived||rec.deleted||!rec.queue?.length){clearInterval(timer);timers.delete(key);return}
              const actual=await locate(key);
              if(actual.state!=="idle")return;
              const head=rec.queue[0];
              await api("cli-agents/send",{key,text:head.text});
              rec.queue=rec.queue.filter(q=>q.id!==head.id);
            }catch(error){rec.error=String(error.message);clearInterval(timer);timers.delete(key)}
            finally{pending.delete(key)}
          },1200);
          timers.set(key,timer);
        }
        return {};
      }
      default:throw Error("未知评审操作");
    }
  }
  core.setRequestRouter(async(req,res)=>{
    const uri=new URL(req.url,core.origin);
    if(uri.pathname!=="/review"&&!uri.pathname.startsWith("/__review/"))return false;
    if(req.headers.host!==new URL(core.origin).host || (req.headers.origin && req.headers.origin!==core.origin)){res.writeHead(403);res.end();return true}
    res.setHeader("Cache-Control","no-store");
    if(uri.pathname==="/review" && req.method==="GET"){
      res.setHeader("Content-Type","text/html; charset=utf-8");
      res.end('<!doctype html><meta charset="utf-8"><title>NexAgent 项目评审</title><p>正在进入隔离工作台…</p><script>const post=async(p,d)=>{const r=await fetch("/api/"+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});if(!r.ok)throw Error("启动评审会话失败");return r.json()};(async()=>{await post("session",{token:'+JSON.stringify(bootstrap)+'});const t=await post("auth/start",{account:'+JSON.stringify(email)+',name:"工作台评审"});await post("auth/respond",{...t,password:'+JSON.stringify(password)+'});location.replace("/?workspace=nexagent-review")})().catch(e=>document.querySelector("p").textContent=e.message)</script>');return true;
    }
    const auth=await fetch(core.origin+"/api/cli-agents",{headers:{Cookie:req.headers.cookie||""}});
    if(!auth.ok){res.writeHead(401);res.end();return true}
    res.setHeader("Content-Type","application/json");
    try{
      if(uri.pathname==="/__review/file" && req.method==="POST" && req.headers.origin===core.origin){
        const key=uri.searchParams.get("key"),id=uri.searchParams.get("id");
        await locate(key);
        if(!/^[a-f0-9-]{36}$/.test(id||""))throw Error("无效附件");
        // the class deliberately strips control characters out of attachment names
        // oxlint-disable-next-line no-control-regex
        const name=path.basename(uri.searchParams.get("name")||"file").replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").slice(0,100).replace(/[. ]+$/,"");
        const folder=path.join(dirs.home,"attachments",id);
        const target=path.join(folder,"file-"+(name||"attachment"));
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>32*1024*1024)throw Error("附件超过 32 MB");chunks.push(chunk)}
        await mkdir(folder,{recursive:true});
        try{await writeFile(target,Buffer.concat(chunks),{flag:"wx"})}catch(e){if(e.code!=="EEXIST")throw e}
        res.end(JSON.stringify({path:target}));return true;
      }
      if(uri.pathname==="/__review/git"&&req.method==="GET"){res.end(JSON.stringify(await gitInfo(uri.searchParams.get("key"))));return true}
      if(uri.pathname==="/__review/state"&&req.method==="GET"){res.end(JSON.stringify(state()));return true}
      if(uri.pathname!=="/__review/action"||req.method!=="POST"||req.headers.origin!==core.origin){res.writeHead(403);res.end("{}");return true}
      let body="";for await(const chunk of req){body+=chunk;if(body.length>70000)throw Error("请求过大")}
      const run=serial.then(()=>action(JSON.parse(body)));serial=run.catch(()=>{});const result=await run;
      res.end(JSON.stringify({...result,state:state()}));
    }catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}))}
    return true;
  });
  return ()=>{for(const t of timers.values())clearInterval(t)};
}
