'use strict';

/**
 * Реестр лицензий программной обвязки (код/библиотеки) отдельно от весов нейросетей.
 * Ни один компонент не устанавливается автоматически — используется для аудита и проверки.
 */
const RUNTIME_COMPONENT_LICENSES = Object.freeze([
  {
    id: 'sherpa-onnx-node',
    role: 'Node.js N-API обёртка и JS API для sherpa-onnx',
    license: 'Apache-2.0',
    commercialUseAllowed: true,
    requirements: [
      'Сохранить текст лицензии Apache-2.0 и NOTICE в дистрибутиве',
      'Указать факт модификации файлов при внесении правок в код sherpa-onnx',
    ],
    source: 'https://www.npmjs.com/package/sherpa-onnx-node',
  },
  {
    id: 'sherpa-onnx-win-x64',
    role: 'Предсобранные нативные бинарники Windows x64 (sherpa-onnx.node, sherpa-onnx-c-api.dll)',
    license: 'Apache-2.0',
    commercialUseAllowed: true,
    requirements: ['Сохранить LICENSE и NOTICE проекта k2-fsa/sherpa-onnx'],
    source: 'https://www.npmjs.com/package/sherpa-onnx-win-x64',
  },
  {
    id: 'onnxruntime',
    role: 'Движок инференса ONNX Runtime (onnxruntime.dll внутри sherpa-onnx-win-x64)',
    license: 'MIT',
    commercialUseAllowed: true,
    requirements: ['Сохранить copyright и MIT LICENSE Microsoft ONNX Runtime'],
    source: 'https://github.com/microsoft/onnxruntime/blob/main/LICENSE',
  },
  {
    id: 'kaldi-native-fbank',
    role: 'Потоковый экстрактор мел-фильтров (встроен в sherpa-onnx)',
    license: 'Apache-2.0',
    commercialUseAllowed: true,
    requirements: ['Сохранить Apache-2.0 notice'],
    source: 'https://github.com/csukuangfj/kaldi-native-fbank/blob/master/LICENSE',
  },
]);

/**
 * Каталог проверенных потоковых моделей русского языка для sherpa-onnx.
 * Веса НЕ скачиваются автоматически и хранятся отдельно от исходников Nox и истории чатов.
 */
const RUSSIAN_STREAMING_MODELS = Object.freeze({
  'ru-zipformer-vosk-int8': {
    id: 'ru-zipformer-vosk-int8',
    displayName: 'Russian Streaming Zipformer Small (Vosk, int8)',
    archiveName: 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16',
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16.tar.bz2',
    recommended: true,
    architecture: 'zipformer2_transducer',
    recognizerKind: 'transducer',
    modelType: 'zipformer2',
    language: 'ru',
    sampleRate: 16000,
    featureDim: 80,
    decodingMethod: 'greedy_search',
    approxArchiveSizeMb: 32,
    approxExtractedSizeMb: 35,
    approxRuntimeRamMb: 280,
    files: {
      encoder: ['encoder.int8.onnx', 'encoder.onnx'],
      decoder: ['decoder.int8.onnx', 'decoder.onnx'],
      joiner: ['joiner.int8.onnx', 'joiner.onnx'],
      tokens: ['tokens.txt'],
    },
    optionalFiles: ['bpe.model', 'README.md', 'LICENSE', 'NOTICE', 'ATTRIBUTION.txt'],
    weightsLicense: {
      spdx: 'Apache-2.0',
      upstreamProject: 'alphacep/vosk-model-small-streaming-ru',
      upstreamUrl: 'https://huggingface.co/alphacep/vosk-model-small-streaming-ru',
      repackUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-2025-08-16',
      commercialUseAllowed: true,
      complianceNote:
        'Исходный релиз Alpha Cephei (alphacep/vosk-model-small-streaming-ru) лицензирован под Apache-2.0; в репаке csukuangfj на Hugging Face YAML-тег license не заполнен, поэтому в папке модели обязательно сохраняется локальный NOTICE/ATTRIBUTION с указанием upstream Apache-2.0 и контрольной суммы архива.',
    },
    notes:
      'Основная рекомендованная модель для живых субтитров Nox C7: нативные 16 кГц (совпадает с WASAPI/микрофоном без потери полосы 4-8 кГц), малый размер (~32 МБ), низкий CPU RTF.',
  },
  'ru-zipformer-vosk-fp32': {
    id: 'ru-zipformer-vosk-fp32',
    displayName: 'Russian Streaming Zipformer Small (Vosk, fp32)',
    archiveName: 'sherpa-onnx-streaming-zipformer-small-ru-vosk-2025-08-16',
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-ru-vosk-2025-08-16.tar.bz2',
    recommended: false,
    architecture: 'zipformer2_transducer',
    recognizerKind: 'transducer',
    modelType: 'zipformer2',
    language: 'ru',
    sampleRate: 16000,
    featureDim: 80,
    decodingMethod: 'greedy_search',
    approxArchiveSizeMb: 88,
    approxExtractedSizeMb: 92,
    approxRuntimeRamMb: 380,
    files: {
      encoder: ['encoder.onnx'],
      decoder: ['decoder.onnx'],
      joiner: ['joiner.onnx'],
      tokens: ['tokens.txt'],
    },
    optionalFiles: ['bpe.model', 'README.md', 'LICENSE', 'NOTICE', 'ATTRIBUTION.txt'],
    weightsLicense: {
      spdx: 'Apache-2.0',
      upstreamProject: 'alphacep/vosk-model-small-streaming-ru',
      upstreamUrl: 'https://huggingface.co/alphacep/vosk-model-small-streaming-ru',
      repackUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ru-vosk-2025-08-16',
      commercialUseAllowed: true,
      complianceNote:
        'Исходный релиз Alpha Cephei под Apache-2.0; при упаковке сохраняется локальный NOTICE с атрибуцией Alpha Cephei и хешем архива.',
    },
    notes:
      'Полноточная FP32-версия той же модели Zipformer. Полезна для сравнения точности (WER/CER) против int8-квантизации в benchmark.',
  },
  'ru-tone-ctc-8k': {
    id: 'ru-tone-ctc-8k',
    displayName: 'Russian Streaming T-one Conformer CTC (8 kHz telephony)',
    archiveName: 'sherpa-onnx-streaming-t-one-russian-2025-09-08',
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-t-one-russian-2025-09-08.tar.bz2',
    recommended: false,
    architecture: 't_one_conformer_ctc',
    recognizerKind: 'tone_ctc',
    modelType: null,
    language: 'ru',
    sampleRate: 8000,
    featureDim: 80,
    decodingMethod: 'greedy_search',
    approxArchiveSizeMb: 80,
    approxExtractedSizeMb: 280,
    approxRuntimeRamMb: 450,
    files: {
      model: ['model.int8.onnx', 'model.onnx'],
      tokens: ['tokens.txt'],
    },
    optionalFiles: ['README.md', 'LICENSE', 'NOTICE', 'ATTRIBUTION.txt'],
    weightsLicense: {
      spdx: 'Apache-2.0',
      upstreamProject: 'voicekit-team/T-one (t-tech/T-one)',
      upstreamUrl: 'https://github.com/voicekit-team/T-one',
      repackUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-t-one-russian-2025-09-08',
      commercialUseAllowed: true,
      complianceNote:
        'Явная лицензия Apache-2.0 в upstream voicekit-team/T-one и в репаке sherpa-onnx. Коммерческое использование разрешено при сохранении NOTICE.',
    },
    notes:
      'Заточена под телефонию 8 кГц; для созвонов 16 кГц требуется даунсэмплинг до 8 кГц (теряется полоса 4-8 кГц). Также требует свежей версии sherpa-onnx-node с поддержкой OnlineModelConfig.toneCtc (PR #2567, после 2025-09).',
  },
});

const DEFAULT_RUSSIAN_MODEL_ID = 'ru-zipformer-vosk-int8';

function getModelSpec(modelId = DEFAULT_RUSSIAN_MODEL_ID) {
  const spec = RUSSIAN_STREAMING_MODELS[modelId];
  if (!spec) {
    throw new RangeError(`Неизвестная модель ASR "${modelId}". Доступны: ${Object.keys(RUSSIAN_STREAMING_MODELS).join(', ')}`);
  }
  return spec;
}

function listSupportedModels() {
  return Object.values(RUSSIAN_STREAMING_MODELS);
}

module.exports = {
  DEFAULT_RUSSIAN_MODEL_ID,
  RUSSIAN_STREAMING_MODELS,
  RUNTIME_COMPONENT_LICENSES,
  getModelSpec,
  listSupportedModels,
};
