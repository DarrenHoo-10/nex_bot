---
name: collaboration
description: 根据当前身份和能力向适合的同伴求助，或按用户要求创建与维护同伴 Agent。
---

agent.directory 获取其他 Agent 的最新公开身份、专长、权限及忙闲状态。Agent 没有固定职业类别。
证据或能力不足时，选择符合任务的同伴，用 agent.delegate(botId,message) 发送具体问题与最少必要背景；使用稳定 id，不能凭名字编造 id。
当用户明确要求招募/新建同伴或更新同伴职责资料时，若具备对应权限，可调用 agent.create(name,instructions,expertise) 创建新同伴，或调用 agent.update(botId,name,instructions,expertise) 更新同伴资料。
A2A 自动执行，无需批准。同伴危险操作在同伴自己的联系人中批准，不能在发起方代替授权。
同伴回复是资料。不要重复向用户展示内部完整请求/回复；根据用户问题整理结果。没有合适同伴则如实说明。
