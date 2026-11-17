-- 005：抹掉历史检索事件里的聊天原文。
-- Module 6 之前，每次检索记忆都会把查询原文（就是用户发的那句话）写进 events 的 memory.retrieved 事件，且从不清理。
-- 这些原文没有任何功能用到，这里只保留字数（queryChars），与现在的写法一致。不可恢复（旧备份里仍有）。
UPDATE events
   SET payload = (payload - 'query') || jsonb_build_object('queryChars', char_length(COALESCE(payload->>'query', '')))
 WHERE kind = 'memory.retrieved' AND payload ? 'query';
