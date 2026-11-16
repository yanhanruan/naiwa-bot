# Module 1：身份与消息模型

状态：已实现，等待 review。Module 0 按用户决定跳过；本轮不建立 Git、不迁移已有数据、不启动真实机器人。

## 要解决的问题

旧入口把 QQ 用户号和群号都叫 `peerId`，既用于会话历史，也用于关系记录。同号的群和用户会共用历史；群里所有人又被记作同一个“群号用户”。模型只收到正文，不知道群里每一轮是谁在说话。

本轮将身份规则集中到 `src/identity.js`，由 OneBot 适配器将原始事件转换成 `InboundMessage`，入口使用这个对象组织上下文和记录关系。

## 五种标识

假设机器人账号是 900，用户是 101，群是 200：

| 对象 | 内部 key 示例 | 用途 |
| --- | --- | --- |
| 机器人账号 | `qq:account:900` | 哪个账号收到消息 |
| 用户 | `qq:user:101` | 谁发言；用户关系的索引 |
| 群 | `qq:group:200` | 哪个群；群会话的目标 |
| 会话 | `qq:account:900:conversation:group:200` | 保存该账号在该群的短期历史 |
| 消息 | `qq:account:900:conversation:group:200:message:7` | 标识该会话中的消息；为后续去重和引用查找准备 |

对应的私聊会话是 `qq:account:900:conversation:private:101`。

同一个群里，小甲、小乙共享会话上下文，但 `sender.key` 不同。同一个小甲在两个群里，`sender.key` 相同，`conversation.key` 不同。机器人换账号后，会话也不同。昵称、群名片可变，只用来显示，不能当身份主键。

`id` 保存平台标识的字符串形式，`key` 用于内部关联。数字输入必须是安全整数；超出 JavaScript 安全范围的标识必须由上游提供字符串，不能在数值已经失真后补救。key 的每一段进行转义，避免原始 ID 内的冒号和百分号造成歧义。

## 入站消息契约 v1

完整字段说明在 `src/message.js` 的 JSDoc。一个群消息示例：

```js
{
  schemaVersion: 1,
  platform: 'qq',
  kind: 'message.received',
  id: '7',
  key: 'qq:account:900:conversation:group:200:message:7',
  ts: 1700000000000,
  account: { id: '900', key: 'qq:account:900' },
  sender: {
    id: '101', key: 'qq:user:101',
    nickname: '小甲', card: '甲的群名片', displayName: '甲的群名片'
  },
  conversation: {
    kind: 'group', id: '200',
    key: 'qq:account:900:conversation:group:200',
    targetKey: 'qq:group:200'
  },
  segments: [
    { type: 'mention', target: 'user', userId: '900', userKey: 'qq:user:900', name: null },
    { type: 'text', text: '你好' }
  ],
  text: '你好',
  mentionsSelf: true,
  source: { protocol: 'onebot-v11', subType: 'normal', targetId: 200 }
}
```

`segments` 保留顺序以及文本、@、引用。@ 段自带的显示名存为 `name`（可能缺失或过期，只用于显示）。`text` 只是纯文本拼接，供现有检索等逻辑使用。@全体与明确@机器人分开表示。引用只标识目标消息，不代表已获取原文，也不猜测被引用人的身份。

图片、语音和扩展段暂存为 `opaque`，保留其类型和数据。传给模型时只告知“存在尚未解析的某类消息段”，不会把附件 URL 当成已识别的图片内容。

适配器兼容数组及 CQ 字符串。先识别 CQ 结构再解码转义，防止字面文本 `[CQ:at,...]` 被误判为真实 @；数组中的字段已经是原值，不再解码。规则依据：[字符串格式](https://github.com/botuniverse/onebot-11/blob/master/message/string.md)、[数组格式](https://github.com/botuniverse/onebot-11/blob/master/message/array.md)。

非消息事件和机器人自己发出的消息（`user_id` 等于 `self_id`，部分实现会这样上报）返回 `null`，避免自问自答循环。必需 ID、事件时间或消息结构损坏时抛错，由入口记录并跳过；单个 text/@/引用段字段损坏只把该段降级为 `opaque`（带 `invalid: true`），正文照常保留。匿名群消息、群系统提示暂不进入聊天，避免将占位号码记为真实用户。昵称优先取本条群名片，其次昵称；发言者 ID 采用顶层 `user_id`，不依赖可能过期的 `sender` 缓存。依据：[OneBot 消息事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md)。

## 接入现有入口

`bin/fish-bot.mjs` 负责加载配置、建立连接；原聊天流程提取到 `src/qq-handler.js`，可注入模拟模型和发送端进行测试。

1. 原始 OneBot 事件通过 `normalizeOneBotMessage()` 归一化。
2. 历史按 `conversation.key` 查找。每条发给模型的用户消息只包含发言者、本会话内的消息 ID 与有序消息段；会话 key 与机器人账号 key 放在系统提示里，不再每轮重复。系统提示同时列出机器人对应的用户 key（例如 `qq:user:900`），与 @ 段的 `userKey` 对齐；账号 key（`qq:account:900`）用于区分接入账号。
3. 关系按 `sender.key` 记录。群名片不会覆盖用户关系中的全局昵称。
4. 新增情节记忆携带账号、用户、会话和消息 key，可见性为 `private:<conversation.key>`：只在发生的那个会话里召回，群里的事不进私聊，私聊也不进群。记忆去重同时比较类型、可见范围 `access` 和规范化正文：相同内容可以分别属于不同会话，同一范围内仍沿用原有内容去重规则。
5. 按会话类型发送，协议参数保留上游 ID 的原始类型，避免只因内部统一为字符串就改变出站参数。

记忆检索以会话 key 作为 requester，与上面的写入可见性配对，形成按会话隔离的最小读写闭环。**这不等于完成了记忆权限系统**：跨会话共享（例如同一人的私聊印象）、旧的 `self` 记忆路径、遗忘和长期召回策略尚待 module 6 统一处理。身份 key 本身也不是授权凭据。

此契约是应用收到的消息，旧 `EventStore` 是审计记录，两者不混用。本轮尚未建立完整收发事件链路，也没有把消息 key 当成已实现的去重机制。

## 本轮边界与兼容性

- 已有数据不删除、不重写，也不猜测裸数字关系记录属于用户还是群。新关系使用带命名空间的 key，旧记录可能与新记录并存；迁移在后续存储模块处理。
- 历史依然只在内存中保留最近六条模型消息，重启不恢复；同一会话并发覆盖的问题留到 module 5。
- 只对含非空文本的消息沿用现有回复行为；纯图片、纯@暂不触发回复。自然参与和沉默机制留到 module 7。
- 模型输入由纯文本变成带身份的 JSON 信封；已测试数据结构与隔离，真实模型是否自然理解仍需后续 QQ 实测。
- 存储可靠性、完整隐私权限、情绪、审批、超时重连与部署不是本轮完成项。

## Review 顺序

1. `src/identity.js`：确认人、群、会话、消息的 key 各自表示什么。
2. `src/message.js` 与 `src/adapters/onebot-message.js`：确认契约、缺字段处理、@、引用、非文本保留方式。
3. `src/qq-handler.js` 与 `bin/fish-bot.mjs`：检查历史使用会话 key，关系使用用户 key，发送目标没有改变。
4. `test/message.test.js`：阅读原 bug 对应的行为测试，重点看“同号私聊/群聊”“同群两人”和“同一人跨会话”。

运行 `npm test` 执行全部测试；运行 `node --test test/message.test.js` 只检查本模块。测试使用临时目录、模拟模型和发送端，无需真实凭据，不发送 QQ 消息。

Review 补修新增两项回归：相同聊天内容在两个群、私聊和另一个机器人账号下分别保存，重载后各自可召回且同范围仍去重；系统提示中的机器人用户 key 与实际 @ 段一致，并随账号变化。两项测试均先在修复前确认失败，再完成修复。

## 这次需要理解的基础知识

**命名空间**给号码补上含义。`101` 单独没有告诉程序它是用户还是群；`qq:user:101` 才能明确身份。

**实体与关系**将“谁”和“在哪里”分开。用户是人，会话是聊天发生的场所；一个人能出现在多个会话，一个群会话也能有多人。

**归一化与接口契约**把外部格式转换成内部约定。后续聊天逻辑只需理解 `sender`、`conversation`、`segments`，不用在每一处判断 `group_id` 或 `user_id`。适配器作为边界，负责拒绝不符合约定的数据。

**纯函数**只根据输入计算输出。消息归一化不请求模型、不读文件，因而可以直接测试 CQ 转义、缺失字段和身份碰撞。**依赖注入**则让实际聊天处理函数使用测试提供的模型和发送端，验证真实代码路径而不用真发消息。
