/* Своя картинка на фоне окна. Файл лежит в IndexedDB этого окна: ядро, сеть и диск вне профиля не трогаются.
 * Показом управляет theme-boot.js (look.bg = image), рисует backdrop.css через --own-bg и html[data-own-bg]. */
(() => {
  'use strict';
  const DB = 'nox-backdrop', STORE = 'files', KEY = 'own-bg';
  const MAX_BYTES = 25 * 1024 * 1024;
  const root = document.documentElement;
  let url = null;

  // Одна операция с хранилищем: открыть, выполнить, закрыть.
  const store = (mode, fn) => new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      let tx;
      let req;
      try {
        tx = db.transaction(STORE, mode);
        req = fn(tx.objectStore(STORE));
      } catch (err) {
        db.close();
        reject(err);
        return;
      }
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });

  function show(blob) {
    if (url) URL.revokeObjectURL(url);
    url = blob ? URL.createObjectURL(blob) : null;
    if (url) { root.style.setProperty('--own-bg', `url("${url}")`); root.dataset.ownBg = 'on'; }
    else { root.style.removeProperty('--own-bg'); delete root.dataset.ownBg; }
    document.dispatchEvent(new Event('nox:backdrop'));
  }

  // Причина отказа словами или null. Чистая функция: её проверяет tests/look.test.js.
  function reject(file) {
    if (!file || !/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(file.type || '')) return 'Нужна картинка: PNG, JPG, WebP или GIF';
    if (!(file.size > 0)) return 'Файл пустой';
    if (file.size > MAX_BYTES) return 'Картинка больше 25 МБ';
    return null;
  }
  // Картинка должна не только называться картинкой, но и читаться движком: битый файл
  // с расширением .png иначе сохраняется молча и оставляет пустой фон.
  async function readable(file) {
    if (typeof createImageBitmap !== 'function') return true;
    let bmp = null;
    try {
      bmp = await createImageBitmap(file);
      return !!(bmp && bmp.width > 0 && bmp.height > 0);
    } catch { return false; }
    finally { if (bmp && bmp.close) bmp.close(); }
  }
  async function set(file) {
    const why = reject(file);
    if (why) throw new Error(why);
    if (!(await readable(file))) throw new Error('Файл не читается как картинка');
    await store('readwrite', (s) => s.put(file, KEY));
    show(file);
  }
  async function clear() {
    await store('readwrite', (s) => s.delete(KEY));
    show(null);
  }

  window.NoxBackdrop = { set, clear, has: () => !!url, reject, MAX_BYTES };
  // Нет хранилища или сохранённой картинки — окно остаётся с фоном темы.
  try { store('readonly', (s) => s.get(KEY)).then((blob) => { if (blob) show(blob); }, () => {}); } catch { /* IndexedDB недоступна */ }
})();
