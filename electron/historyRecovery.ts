import type { proto } from '@whiskeysockets/baileys'

// Lógica pura da recuperação de histórico do WhatsApp, separada do
// WhatsAppManager pra poder ser testada sem subir Electron/Baileys.

/**
 * O Baileys entrega o timestamp como number ou como Long (protobuf),
 * dependendo de onde a mensagem veio — `Number()` direto num Long devolve NaN,
 * o que faria toda mensagem parecer velha demais e nunca ser recuperada.
 * Devolve milissegundos (o WhatsApp manda em segundos), ou 0 se não der.
 */
export function messageTimestampMs(msg: proto.IWebMessageInfo): number {
  const raw = msg.messageTimestamp
  if (raw == null) return 0
  const seconds = typeof raw === 'number' ? raw : Number(raw.toString())
  return Number.isFinite(seconds) ? seconds * 1000 : 0
}

export interface SelectOptions {
  monitoredIds: Set<string>
  alreadyProcessedIds: Set<string>
  maxAgeMs: number
  maxPerGroup: number
  now?: number
}

/**
 * Escolhe quais mensagens do histórico valem ser reprocessadas como se fossem
 * novas: só de grupo monitorado, dentro da janela de tempo, sem repetir o que
 * já foi processado, e com teto por grupo — mantendo as mais recentes quando
 * o teto estoura (oferta velha é a que menos importa recuperar).
 */
export function selectRecoverableMessages(
  messages: proto.IWebMessageInfo[],
  options: SelectOptions
): proto.IWebMessageInfo[] {
  const { monitoredIds, alreadyProcessedIds, maxAgeMs, maxPerGroup } = options
  if (monitoredIds.size === 0) return []

  const cutoff = (options.now ?? Date.now()) - maxAgeMs
  const perGroupCount = new Map<string, number>()
  const selected: proto.IWebMessageInfo[] = []

  const sorted = [...messages].sort((a, b) => messageTimestampMs(b) - messageTimestampMs(a))

  for (const msg of sorted) {
    const jid = msg.key?.remoteJid
    const id = msg.key?.id
    if (!jid || !id || msg.key?.fromMe) continue
    if (!monitoredIds.has(jid)) continue
    if (messageTimestampMs(msg) < cutoff) continue
    if (alreadyProcessedIds.has(id)) continue

    const count = perGroupCount.get(jid) ?? 0
    if (count >= maxPerGroup) continue
    perGroupCount.set(jid, count + 1)
    selected.push(msg)
  }

  return selected
}

/**
 * Guarda as mensagens recentes por grupo, com teto — sem isso um app rodando
 * dias a fio com vários grupos acumularia isso pra sempre na memória.
 */
export function bufferMessages(
  buffer: Map<string, proto.IWebMessageInfo[]>,
  messages: proto.IWebMessageInfo[],
  maxAgeMs: number,
  maxPerGroup: number,
  now: number = Date.now()
): void {
  const cutoff = now - maxAgeMs
  for (const msg of messages) {
    const jid = msg.key?.remoteJid
    if (!jid || msg.key?.fromMe) continue
    if (messageTimestampMs(msg) < cutoff) continue

    const existing = buffer.get(jid) ?? []
    existing.push(msg)
    if (existing.length > maxPerGroup) {
      existing.splice(0, existing.length - maxPerGroup)
    }
    buffer.set(jid, existing)
  }
}

/** Mantém o Set de ids processados abaixo do teto, descartando os mais antigos. */
export function trimProcessedIds(ids: Set<string>, cap: number): void {
  if (ids.size <= cap) return
  const excess = ids.size - cap
  let removed = 0
  for (const id of ids) {
    if (removed++ >= excess) break
    ids.delete(id)
  }
}
