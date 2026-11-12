require('node:test').test('виснет', () => new Promise(() => { setInterval(() => {}, 1000); }));
