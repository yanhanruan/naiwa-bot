-- 007：奶蛙的心情（见 docs/module-08-mood-design.md）。
-- 心情只有一份（每个租户一行），不按群、不按人存；旧的心情和好感一并删掉。

-- 1. 今天的心情。档位：-2 很低落、-1 有点低落、0 平常、1 开心、2 很开心。
--    day：北京时间早上 5 点换天；base：今天的基调；manual：是不是运营用命令改的；
--    ripple：日内起伏（-1～1，离基调最多一档），ripple_at：起伏算到的时间（读的时候按过了多久往回减）；
--    previous_base：昨天的基调（负面的不连着两天）。
CREATE TABLE mood_state (
  tenant_id     text             PRIMARY KEY,
  day           date             NOT NULL,
  base          smallint         NOT NULL CHECK (base BETWEEN -2 AND 2),
  manual        boolean          NOT NULL DEFAULT false,
  previous_base smallint         CHECK (previous_base BETWEEN -2 AND 2),
  ripple        double precision NOT NULL DEFAULT 0 CHECK (ripple BETWEEN -1 AND 1),
  ripple_at     timestamptz      NOT NULL
);

-- 2. 旧的心情（三个数，规则加减，回复时从来没用上）。表留着记角色创建时间。
ALTER TABLE character_state DROP COLUMN mood, DROP COLUMN last_tick_at;

-- 3. 好感（每条消息 +0.05，没有意义）和备注（从来没用过）。互动次数、第一次见面时间保留。
ALTER TABLE relationships DROP COLUMN sentiment, DROP COLUMN notes;
