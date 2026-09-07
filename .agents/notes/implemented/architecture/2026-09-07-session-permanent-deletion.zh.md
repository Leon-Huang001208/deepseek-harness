# Agent Note: 不可逆会话删除边界

Status: implemented

[English](2026-09-07-session-permanent-deletion.md) | 中文

## Problem

Workspace 归档会有意隐藏 Session，但不触碰其持久事件日志、衍生查询行、投影缓存或 Workspace 记账。因此，产品级保留策略不能把归档当作永久删除；否则会无限期保留用户数据，也无法确认 DSH 主记录已经消失。只删除产品本地索引存在同样缺陷；删除活动 Session 还会与仍可追加事件的 agent 形成竞态。

## Decision

通过显式 Host RPC `session.delete({ sessionId, cascade? })` 暴露不可逆删除。网关解析持久化与活动血统；仍有后代时要求级联，并在改变任何状态前预检完整目标集。正在创建、agent 正在运行，或活动 agent 不归本 API 实例所有的目标都会以 `session-delete-blocked` 拒绝。归 API 所有的空闲句柄会先 dispose，使持久化退役在存储改变前达到完全停稳。

清理按子级优先顺序跨越衍生存储与主存储。对每个目标，网关依次删除 session-query 行、投影缓存单元、Workspace 成员关系与归档引用，最后调用 `SessionPersistence.delete()`。JSONL 只 unlink 后端精确解析出的 transcript，并且只移除删除后为空的容器；SQLite 在事务中删除会话行，并依靠外键级联删除事件行。根会话缺失时仍视为幂等成功；响应列出每个已删除 Session id，使调用方可以在清除自己的 tombstone 前要求明确的原生确认。

DSH 拥有删除原语，而不拥有保留期调度器。调用产品负责可恢复宽限期，在此期间记录 tombstone，并在到期或用户显式执行永久删除后调用 `session.delete`。衍生清理失败时主记录仍然保留，调用方可以重试；主记录删除成功后不再能够恢复。

## Consequences

- 归档仍是可恢复的展示操作，不会被重新定义为删除。
- 第一方持久化提供方实现相同的冷会话删除约定，包括对缺失或从未实体化 id 的安全幂等重试。
- 经宿主确认删除后，衍生 session-query、投影缓存和 Workspace 状态不再保留引用。
- 产品可以声明有限保留策略，而不需要让 DSH 承担产品特定的计时或后台任务策略。
- 该操作会有意保守地处理活动所有权；被阻止的删除必须在所属运行时进入安全状态或重启后重试。

## Alternatives considered

- **把 Workspace 归档当作删除**——否决，因为归档可恢复，并且会有意保留事件日志和 Workspace 记账。
- **只删除产品侧会话索引**——否决，因为 DSH transcript 与衍生状态仍会无限期保留。
- **递归移除会话目录**——否决，因为宽泛的文件系统删除会扩大损害面，并可能跨越链接；JSONL 提供方只 unlink 其精确产物。
- **强制删除活动 Session**——否决，因为活动 agent 能在清理期间或之后追加事件，使删除声明失真。
- **在 DSH 中放置 30 天调度器**——否决，因为宽限期、恢复 UX 与保留策略属于调用产品；DSH 只提供不可逆原语及其安全边界。
