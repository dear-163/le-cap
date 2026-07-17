// 2026-07-16晚上Cloudflare D1發生過一次全服務層級中斷（連SELECT 1都失敗），影響所有
// 依賴D1的API同時失效，首頁所有卡片一起消失、沒有任何分級式降級。這裡提供一個輕量的
// 「最近一次成功回應」快照機制：每次API成功回傳時順手存一份進KV，D1掛掉時退回讀這份
// 快照（標示stale讓前端可以選擇要不要提示使用者），而不是整格消失。
// KV沒有事務保證、也可能過期或被驅逐，這只是「有比沒有好」的最後防線，不是正確性保證。
const PREFIX = 'snapshot:';

export async function saveSnapshot(env, key, data) {
  if (!env.SNAPSHOT_KV) return;
  try {
    await env.SNAPSHOT_KV.put(PREFIX + key, JSON.stringify({ data, savedAt: new Date().toISOString() }));
  } catch (e) {
    // KV寫入失敗不該影響主要回應，只是這次沒有更新快照而已。
    console.error(`[kvSnapshot] 寫入快照失敗（key=${key}）：`, e.message);
  }
}

export async function loadSnapshotFallback(env, key) {
  if (!env.SNAPSHOT_KV) return null;
  try {
    const raw = await env.SNAPSHOT_KV.get(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { ...parsed.data, stale: true, staleSince: parsed.savedAt };
  } catch (e) {
    console.error(`[kvSnapshot] 讀取快照失敗（key=${key}）：`, e.message);
    return null;
  }
}
