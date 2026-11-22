export const githubMonitorCapability = {
  name: "GitHub 仓库监视与 Webhook 推送",
  description: "NexBot 的主工作区可以接收 GitHub 推送。GitHub 创建 PR 时，仓库监视可以通知指定助手或启动任务。用户在连接器 → GitHub → 添加监视中选择仓库和助手，勾选「同时生成 Webhook」，再将生成的地址和密钥填入 GitHub 仓库 Webhooks，订阅 Pull requests。账号独立工作区暂不支持按工作区路由。具体仓库是否已配置需另行核实。",
};
