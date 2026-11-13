'use strict';

/**
 * Наборы синтетических реплик для демонстрации и проверки прототипа C7.
 * Реальные голосовые данные и микрофон не используются.
 */

const STANDUP_UTTERANCES = [
  {
    id: 'u1',
    startMs: 200,
    endMs: 2400,
    channel: 'system_loopback',
    speakerHint: 'remote:S1',
    text: 'Всем привет. Давайте начнём синхронизацию по релизу клиента Windows.',
  },
  {
    id: 'u2',
    startMs: 2600,
    endMs: 5200,
    channel: 'microphone',
    speakerHint: 'local:mic',
    text: 'Привет! У нас готова проверка очереди фрагментов и защита от утечки памяти.',
  },
  {
    id: 'u3',
    startMs: 5500,
    endMs: 8500,
    channel: 'system_loopback',
    speakerHint: 'remote:S2',
    text: 'А успеем ли мы закрыть тесты восстановления после обрыва соединения до пятницы?',
  },
  {
    id: 'u4',
    startMs: 8800,
    endMs: 11800,
    channel: 'microphone',
    speakerHint: 'local:mic',
    text: 'Да, решили перенести реальный аудиозахват во второй этап и сначала утвердить контракт.',
  },
  {
    id: 'u5',
    startMs: 12200,
    endMs: 15200,
    channel: 'system_loopback',
    speakerHint: 'remote:S1',
    text: 'Договорились, тогда нужно подготовить отчёт по задержкам и список зависимостей на согласование.',
  },
  {
    id: 'u6',
    startMs: 15500,
    endMs: 18000,
    channel: 'system_loopback',
    speakerHint: 'remote:S2',
    text: 'Кто проверит коммерческие лицензии моделей распознавания?',
  },
];

function buildScenarioConfig(kind = 'standup') {
  switch (kind) {
    case 'fault_recovery':
      return {
        id: 'fault_recovery',
        title: 'Синтетический созвон со сбоем и автовосстановлением провайдера',
        utterances: STANDUP_UTTERANCES,
        adapterOptions: { chunkDurationMs: 200, paceMs: 120 },
        providerOptions: { failAtPushCount: 16, failTimes: 1, simulatedDelayMs: 18 },
      };
    case 'edge_cases':
      return {
        id: 'edge_cases',
        title: 'Поздние ответы, дубликаты и битые метки времени',
        utterances: STANDUP_UTTERANCES,
        adapterOptions: { chunkDurationMs: 200, paceMs: 100 },
        providerOptions: {
          emitDuplicates: true,
          emitLateResult: true,
          emitBadTimestamps: true,
          simulatedDelayMs: 15,
        },
      };
    case 'storage_error':
      return {
        id: 'storage_error',
        title: 'Созвон с имитацией ошибки записи на диск',
        utterances: STANDUP_UTTERANCES.slice(0, 4),
        adapterOptions: { chunkDurationMs: 200, paceMs: 100 },
        providerOptions: { simulatedDelayMs: 12 },
        failOnWrite: true,
      };
    case 'standup':
    default:
      return {
        id: 'standup',
        title: 'Рабочая встреча (синтетические субтитры, 3 канала/участника)',
        utterances: STANDUP_UTTERANCES,
        adapterOptions: { chunkDurationMs: 200, paceMs: 120 },
        providerOptions: { simulatedDelayMs: 16 },
      };
  }
}

module.exports = {
  STANDUP_UTTERANCES,
  buildScenarioConfig,
};
