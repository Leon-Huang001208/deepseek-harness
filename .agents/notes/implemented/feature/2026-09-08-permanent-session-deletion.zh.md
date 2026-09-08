# Agent Note: Session 永久删除

Status: implemented

[English](2026-09-08-permanent-session-deletion.md) | 中文

## Problem

Session persistence 可以创建、恢复、列出和归档持久对话，却无法擦除它。提供可恢复保留期的产品仍需要一项最终操作，将已过期或明确清除的 Session 从权威日志及每个派生所有者中移除。只删除产品索引会把私密内容留在 DSH 中；只删除日志则会留下指向已不存在 identity 的搜索结果、projection row 与 Workspace 引用。

live Agent 还使删除成为生命周期操作，而非文件系统命令。在 loop 写入期间移除存储可能破坏日志，也可能让活动 identity 在持久历史消失后继续运行。Subagent 日志形成谱系，删除普通父会话时不能留下其后代。

## Decision

Session Controller 发布 `session/delete`，用于永久删除一个普通 Session。它发现完整的持久和 live 谱系，拒绝直接指定 subagent，以最深后代优先、请求根最后的顺序排列目标，并在更改派生状态或持久状态前执行一次完整的活性预检。正在运行的 Agent、尚未结束的创建或恢复、不带 controller 自有 Agent handle 的 attached Session，或者由 controller 之外持有的 live Agent，都会返回稳定的 busy 失败且不产生变更。handle 属于 controller 的空闲 Agent 会在清理前销毁。

对于每个目标，controller 会使 Session Query 状态失效、删除其 projection-cache row、移除 Workspace 与归档引用，然后调用 persistence provider。JSONL provider 在移除所有 generation 与临时产物之前，会取得进程内写入者认领和稳定的跨进程租约。它保留空的 `session.lock` inode，使后续使用同一 id 的 create 无法绕过仍持有原锁的进程。物理移除开始前均响应取消；开始后则完成删除，避免目录只被清理一半。

根日志是最后移除的权威产物。如果后代清理失败，根仍可寻址，调用方可以重试级联；已经移除的后代只会从下一次发现中消失。完成的操作按实际应用顺序返回 `deletedSessionIds`。根消失后再次调用返回 `session/not-found`。

通用 `SessionPersistence.delete` 方法提供遇错关闭的默认实现，会拒绝不支持删除的 provider。持久化实现必须明确选择支持，并证明其所有权、取消与不存在语义，Host 才能依赖删除。

## Alternatives considered

**让每个嵌入产品直接删除 DSH 文件。** 否决，因为产品不拥有持久化布局、格式 generation、写入者租约或 DSH 派生状态。这会把保留策略耦合到私有路径，并使格式演进不安全。

**只删除请求的根而保留后代。** 否决，因为 child Session 可能包含委派的用户上下文与输出。父级保留承诺必须覆盖完整谱系。

**删除时强制停止每个 live Agent。** 否决，因为删除请求不能把活动计算变成隐式取消。busy 与外部持有的 identity 以零变更失败；调用方可以通过既有生命周期 API 取消，并在静止后重试。

**随 Session 数据一起移除稳定锁文件。** 否决，因为 unlink 一个仍被持有的 POSIX 锁会让同一路径产生第二个 inode，使新写入方能在旧进程仍持有第一个锁时进入。保留空锁 inode 可在不保留 Session 内容的同时维持排他。

## Consequences

- 嵌入产品无需了解 DSH 存储内部即可实现保留期和用户请求的清除。
- 永久删除覆盖 subagent 后代、查询索引、projection cache、Workspace 成员关系、归档引用与持久 JSONL generation。
- 对直接 subagent identity 有意不提供该操作，对活动或外部持有的 Session 也有意不强制执行。
- 级联失败后可能需要重试。根最后删除的顺序保留了重试 identity，但独立所有者之间的清理不是分布式事务。
- 共享内容寻址产物继续由各自的引用所有权管理；Session 删除移除 Session 自有记录与引用，不移除无关消费方的数据。

## Testing

可复用 persistence contract 覆盖已关闭会话删除、重复不存在、写入者所有权、提交前取消与新实例可见性。JSONL 测试覆盖原始文本和 Zstandard 根以及跨进程租约。Session Controller 测试覆盖确定性的后代顺序、派生清理、直接 child 拒绝、运行中与外部持有 live 拒绝、controller 自有空闲 Agent 销毁、重复删除，以及预检失败时零变更。Query、projection cache 与 Workspace 测试分别钉住各自的 forget 操作。
