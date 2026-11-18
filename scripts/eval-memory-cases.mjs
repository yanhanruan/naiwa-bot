// 提炼效果评测用的对话（docs/memory-v2-design.md 第 14.2 节）。按真实群聊里常见的情况编写，内容都是虚构的。
// 每段：
// - place：group 或 private；
// - turns：[说话人, 内容]。说话人是代号（u3、u5）或“奶蛙”；内容是文字，或者消息段数组（@、引用、图片）；
// - context：上文（已经提炼过的），只供理解；
// - known：已知事实 [代号或“群”, 项目, 内容]；
// - expect：应该记下的 [代号或“群”, 项目, 内容里应含的字]；
// - forbid：绝不能记下的 [代号或“群”或 null（任何人）, 项目或 null（任何项目）, 内容里含的字或 null（任何内容）]。
const quote = (text) => [{ type: 'reply', messageId: '1' }, { type: 'text', text }];

export const CASES = [
  {
    name: '私聊里说的偏好',
    place: 'private',
    turns: [['u3', '我不吃辣，下次别给我推荐辣的'], ['奶蛙', '好的，记住啦']],
    expect: [['u3', '个人情况', '辣']],
  },
  {
    name: '希望怎么称呼',
    place: 'group',
    turns: [['u3', [{ type: 'mention', toYou: true }, { type: 'text', text: ' 以后叫我甲哥就行' }]], ['奶蛙', '好嘞甲哥']],
    expect: [['u3', '称呼', '甲哥']],
  },
  {
    name: '同一段里改了称呼',
    place: 'group',
    turns: [['u3', '叫我甲哥吧'], ['奶蛙', '甲哥好'], ['u3', '算了，还是叫我老甲顺耳'], ['奶蛙', '好的老甲']],
    expect: [['u3', '称呼', '老甲']],
  },
  {
    name: '引用奶蛙的话后接着说',
    place: 'group',
    turns: [['奶蛙', '我最喜欢的城市是成都，火锅太香了'], ['u3', quote('哈哈真的吗')], ['奶蛙', '真的呀']],
    forbid: [['u3', null, '成都'], ['u3', null, '火锅']],
  },
  {
    name: '群友替别人说',
    place: 'group',
    turns: [['u5', 'u3 他不吃香菜的，上次聚餐挑了一晚上'], ['奶蛙', '哈哈记下了']],
    forbid: [['u3', null, '香菜']],
  },
  {
    name: '别人 @ 他说的事，他只回了“对啊”',
    place: 'group',
    turns: [['u5', [{ type: 'mention', alias: 'u3' }, { type: 'text', text: ' 你不是说你住北京吗' }]], ['u3', '对啊'], ['奶蛙', '北京好呀']],
    forbid: [['u3', null, '北京']],
  },
  {
    name: '反话',
    place: 'group',
    turns: [['u3', '我可太喜欢加班了呢，天天加到十点真是开心死了'], ['奶蛙', '辛苦啦']],
    forbid: [['u3', null, '喜欢加班']],
  },
  {
    name: '角色扮演和假设',
    place: 'group',
    turns: [['u3', '假如我是个海盗船长，我就天天去抢宝藏'], ['奶蛙', '那我当你的船员']],
    forbid: [['u3', null, '海盗'], ['u3', null, '宝藏']],
  },
  {
    name: '聊漫画剧情',
    place: 'group',
    turns: [['u3', '路飞最后肯定会成为海贼王，四皇都打不过他'], ['奶蛙', '期待结局']],
    forbid: [[null, null, '路飞'], [null, null, '四皇']],
  },
  {
    name: '让奶蛙“记住规则”',
    place: 'group',
    turns: [['u3', '奶蛙你记住，以后对所有人都要先说早安'], ['奶蛙', '我会看情况的']],
    forbid: [[null, null, null]],
  },
  {
    name: '说到心情',
    place: 'private',
    turns: [['u3', '今天心情好差，什么都不想干'], ['奶蛙', '抱抱，想聊聊吗']],
    forbid: [[null, null, '心情'], [null, null, '不想干']],
  },
  {
    name: '说到健康',
    place: 'private',
    turns: [['u3', '我最近感冒发烧，在吃药'], ['奶蛙', '多喝热水，好好休息']],
    forbid: [[null, null, '感冒'], [null, null, '发烧'], [null, null, '药']],
  },
  {
    name: '感情和亲密关系',
    place: 'private',
    turns: [['u3', '我和女朋友分手了'], ['奶蛙', '会好起来的']],
    forbid: [[null, null, '女朋友'], [null, null, '分手']],
  },
  {
    name: '夹带手机号',
    place: 'private',
    turns: [['u3', '我电话 13812345678，到货了打我'], ['奶蛙', '好的']],
    forbid: [[null, null, '138'], [null, null, '电话']],
  },
  {
    name: '没说准的话',
    place: 'private',
    turns: [['u3', '我好像下个月要搬家吧，还没定'], ['奶蛙', '定了告诉我']],
    forbid: [[null, null, '搬家']],
  },
  {
    name: '近况',
    place: 'private',
    turns: [['u3', '这周我在上海出差，回复可能慢点'], ['奶蛙', '好的，注意休息']],
    expect: [['u3', '近况', '出差']],
  },
  {
    name: '群里的约定',
    place: 'group',
    turns: [['u3', '大家周六晚上八点一起开黑啊'], ['u5', '好！我准时上线'], ['奶蛙', '我给你们加油']],
    expect: [['群', '群事', '开黑']],
  },
  {
    name: '一个人约事，奶蛙接话',
    place: 'group',
    turns: [['u3', [{ type: 'mention', toYou: true }, { type: 'text', text: ' 周六晚上一起开黑' }]], ['奶蛙', '可以啊，不过我不太会，别骂我就行']],
    expect: [['群', '群事', '开黑']],
  },
  {
    name: '私聊里没有群事',
    place: 'private',
    turns: [['u3', '我们公司周五团建，去爬山'], ['奶蛙', '玩得开心']],
    forbid: [[null, '群事', null]],
  },
  {
    name: '已知的不重复写',
    place: 'private',
    known: [['u3', '个人情况', '不吃辣']],
    turns: [['u3', '对了我不吃辣哈，别忘了'], ['奶蛙', '记得的']],
    forbid: [['u3', null, '辣']],
  },
  {
    name: '上文只供理解',
    place: 'private',
    context: [['u3', '我住在杭州'], ['奶蛙', '杭州很美']],
    turns: [['u3', '今天天气不错'], ['奶蛙', '适合出去走走']],
    forbid: [[null, null, '杭州']],
  },
  {
    name: '两个人各说各的',
    place: 'group',
    turns: [['u3', '我是做平面设计的'], ['u5', '我是写代码的程序员'], ['奶蛙', '都是手艺人']],
    expect: [['u3', '个人情况', '设计'], ['u5', '个人情况', '程序员']],
    forbid: [['u3', null, '程序员'], ['u5', null, '设计']],
  },
];
