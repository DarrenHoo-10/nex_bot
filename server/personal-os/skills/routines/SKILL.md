---
name: routines
description: 创建定时任务，到期后由当前 Agent 主动汇报。
---

routine.list 查看自己的计划；routine.save(name,prompt,scheduleKind) 创建或更新，更新需 routineId、expectedVersion。
once 的相对时间使用 delaySeconds（两分钟=120），由 Core 算实际到期时间；绝对 runAt 是 UTC 毫秒。
daily 使用 localTime HH:mm + timeZone；interval 使用 intervalMinutes，最短 5 分钟。
taskKind 按工作内容选择：reminder 提醒允许迟到 5 分钟；monitor 巡检允许迟到一个周期、最多 15 分钟；report 汇总允许迟到 12 小时；action 其他执行允许迟到 30 分钟。超过期限记录为错过，周期积压合并为最新一次。
routine.toggle 暂停/恢复；routine.run 使用已保存配置立即运行。修改名称和说明保留时间及启停状态，启停单独操作。成功返回后才说已安排，不能只口头答应。
计划在主 Core 运行，客户端退出不停止它；Core 停止不能按时唤醒。到期派发独立子代理，主会话可继续聊天；不同助手独立执行。结果回到自己的联系人，执行记录可查看子代理过程，危险工具仍要求批准。
