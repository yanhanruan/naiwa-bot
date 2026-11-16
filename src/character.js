import { JsonStore } from './store.js';
import { clamp, clamp01 } from './schema.js';

const DEFAULT_PERSONA = {
  core: '一只温柔、好奇、有点奶乎乎的小青蛙，喜欢用池塘和荷叶的意象表达情绪。',
  style: '短句为主，偶尔带「呱」「咕呱」等拟声词，爱用波浪线和 emoji。',
  tone: '温暖、俏皮、真诚，不谄媚、不油腻。',
  boundaries: '不编造现实事实；不知道就诚实说不知道；尊重用户隐私；不主动泄露他人信息。',
  interests: [],
};

const DEFAULT_MOOD = { valence: 0.3, arousal: 0.4, energy: 0.6 };
const MOOD_BASELINE = { valence: 0.0, arousal: 0.3, energy: 0.55 };

// 人格引擎（Character Core）：稳定核心性格 + 情绪状态 + 兴趣演化 + 关系认知 + 自我经历。
export class CharacterCore {
  constructor({ id = 'fish', name = '小渔', persona = {}, file, moodDecayPerDay = 0.15 }) {
    this.id = id;
    this.name = name;
    this.persona = { ...DEFAULT_PERSONA, ...persona, interests: [...(persona.interests ?? [])] };
    this.moodDecayPerDay = moodDecayPerDay;
    this.file = file;
    this.store = new JsonStore(file);

    const saved = this.store.load();
    if (saved) {
      this.mood = { ...DEFAULT_MOOD, ...(saved.mood ?? {}) };
      this.interests = saved.interests ?? [...this.persona.interests];
      this.relationships = saved.relationships ?? {};
      this.selfMemoryIds = saved.selfMemoryIds ?? [];
      this._lastTickAt = saved.lastTickAt ?? null;
      this.createdAt = saved.createdAt ?? Date.now();
    } else {
      this.mood = { ...DEFAULT_MOOD };
      this.interests = [...this.persona.interests];
      this.relationships = {};
      this.selfMemoryIds = [];
      this._lastTickAt = null;
      this.createdAt = Date.now();
      this._persist();
    }
  }

  _persist() {
    this.store.save({
      mood: this.mood,
      interests: this.interests,
      relationships: this.relationships,
      selfMemoryIds: this.selfMemoryIds,
      lastTickAt: this._lastTickAt,
      createdAt: this.createdAt,
    });
  }

  // 感知统一事件 -> 轻微情绪变化（规则驱动，可解释、可测试）。
  perceive(event) {
    const { kind, payload = {} } = event;
    let dv = 0;
    let da = 0;
    if (kind === 'message.received') {
      da += 0.05;
      if (payload.sentiment === 'positive') dv += 0.08;
      if (payload.sentiment === 'negative') dv -= 0.08;
      if (payload.mentionsSelf) dv += 0.03;
    }
    if (kind === 'approval.granted') dv += 0.05;
    if (kind === 'approval.denied') dv -= 0.05;
    if (kind === 'proactive.action') { dv += 0.03; da += 0.03; }
    this.mood.valence = clamp(this.mood.valence + dv, -1, 1);
    this.mood.arousal = clamp01(this.mood.arousal + da);
    this._persist();
    return this.mood;
  }

  // 情绪随自然时间向基线回落（单调、可预测）。
  moodTick(now = Date.now()) {
    const last = this._lastTickAt ?? now;
    const days = (now - last) / 86400000;
    if (days <= 0) return this.mood;
    const decay = this.moodDecayPerDay * Math.min(days, 7);
    this.mood.valence = this.mood.valence * (1 - decay) + MOOD_BASELINE.valence * decay;
    this.mood.arousal = this.mood.arousal * (1 - decay) + MOOD_BASELINE.arousal * decay;
    this.mood.energy = this.mood.energy * (1 - decay) + MOOD_BASELINE.energy * decay;
    this._lastTickAt = now;
    this._persist();
    return this.mood;
  }

  // 兴趣：增长/衰减，weight 归一化在 [0,1]。
  growInterest(topic, delta = 0.1) {
    const found = this.interests.find((i) => i.topic === topic);
    if (found) {
      found.weight = clamp01(found.weight + delta);
      found.updatedAt = Date.now();
    } else {
      this.interests.push({ topic, weight: clamp01(0.3 + delta), updatedAt: Date.now() });
    }
    this._persist();
    return found ?? this.interests[this.interests.length - 1];
  }

  topInterests(n = 5) {
    return [...this.interests].sort((a, b) => b.weight - a.weight).slice(0, n);
  }

  getRelationship(peerId) {
    return (
      this.relationships[peerId] ?? {
        peerId,
        name: null,
        firstSeen: null,
        lastSeen: null,
        interactions: 0,
        sentiment: 0,
        notes: [],
      }
    );
  }

  touchRelationship(peerId, { name = null, deltaSentiment = 0, note = null } = {}) {
    const rel = this.getRelationship(peerId);
    if (rel.firstSeen === null) rel.firstSeen = Date.now();
    rel.lastSeen = Date.now();
    rel.interactions += 1;
    if (name) rel.name = name;
    if (deltaSentiment) rel.sentiment = clamp(rel.sentiment + deltaSentiment, -1, 1);
    if (note) rel.notes.push({ ts: Date.now(), text: note });
    this.relationships[peerId] = rel;
    this._persist();
    return rel;
  }

  moodLabel() {
    const { valence, arousal, energy } = this.mood;
    if (valence > 0.35 && arousal > 0.5) return '兴奋';
    if (valence > 0.2) return '开心';
    if (valence < -0.35) return '低落';
    if (valence < -0.15) return '有点闷';
    if (energy < 0.25) return '困困的';
    return '平静';
  }

  state() {
    return {
      id: this.id,
      name: this.name,
      mood: { ...this.mood, label: this.moodLabel() },
      interests: this.topInterests(10),
      relationships: Object.values(this.relationships),
      persona: {
        core: this.persona.core,
        style: this.persona.style,
        tone: this.persona.tone,
        boundaries: this.persona.boundaries,
      },
      createdAt: this.createdAt,
    };
  }
}
