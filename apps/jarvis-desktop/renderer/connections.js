/* Раздел «Подключения»: внешние сервисы MCP.
 *
 * Экран в дизайн-системе Nox (Phase 3.2): список подключений с семью состояниями,
 * поиск и фильтры, панель популярных сервисов, диалоги добавления/деталей/удаления/
 * подтверждения изменений/ошибки. Данные и действия — только через существующий мост:
 * mcpState / mcpAdd / mcpToggle / mcpRemove / mcpApprove; новых каналов нет.
 *
 * Честность важнее вида: «Подключён» показывается только при реально установленном
 * соединении; сохранённый, но не подключившийся сервис — «Ошибка» с причиной; сервис
 * без подключения — «Не подключён»; изменившийся набор действий — «Изменения инструментов»
 * и блокировка действий до mcpApprove. Подтверждение набора действий сервиса (mcpApprove)
 * не смешивается с разрешением агенту выполнять системные действия (approval:respond). */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const list = document.getElementById('mcpList');
  const empty = document.getElementById('mcpEmpty');
  const form = document.getElementById('mcpForm');
  if (!list || !empty || !form) return;
  const note = document.getElementById('mcpFormNote');
  const view = document.querySelector('[data-view="mcp"]');
  const POLL_MS = 3000;

  // ── начало списка популярных
  // Заголовок панели в интерфейсе — «Популярные». Короткая безопасная часть каталога
  // src/mcp/catalog.js: окно не имеет доступа к ядру (nodeIntegration выключен), поэтому
  // данные записаны здесь; тест mcp-catalog сверяет id, команду и аргументы с каталогом.
  // Только записи без ключей и проверенные (verified: true): «Добавить» ставит сервис сразу,
  // секреты сюда не подставляются.
  const POPULAR = [
    { id: 'puppeteer', title: 'Браузер Puppeteer', hint: 'Страницы и снимки в настоящем браузере', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-puppeteer' },
    { id: 'memory', title: 'Память', hint: 'Долгая память в виде графа знаний', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-memory' },
    { id: 'postgres', title: 'PostgreSQL', hint: 'Запросы только на чтение к базе PostgreSQL', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-postgres postgresql://localhost/postgres' },
    { id: 'playwright', title: 'Браузер Playwright', hint: 'Управление настоящим браузером и снимки экрана', target: 'npx.cmd', args: '-y @playwright/mcp@latest' },
    { id: 'context7', title: 'Context7', hint: 'Свежая документация библиотек для модели', target: 'npx.cmd', args: '-y @upstash/context7-mcp' },
    { id: 'sequential-thinking', title: 'Рассуждения', hint: 'Пошаговые рассуждения со структурой мыслей', target: 'npx.cmd', args: '-y @modelcontextprotocol/server-sequential-thinking' },
  ];
  // ── конец списка популярных

  // Контуры знаков: Simple Icons 14, Slack из Simple Icons 11.
  const BRAND_ICONS = {
    github: { color: '#fff', path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12' },
    gitlab: { color: '#fc6d26', path: 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z' },
    gmail: { color: '#ea4335', path: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z' },
    gdrive: { color: '#34a853', path: 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z' },
    slack: { color: '#e01e5a', path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z' },
  };
  const SERVICE_ICONS = {
    puppeteer: 'globe', memory: 'book', postgres: 'file',
    playwright: 'play', context7: 'book', 'sequential-thinking': 'bolt',
  };

  function popularIcon(id) {
    const brand = null;
    if (id === 'playwright') return el('span', { class: 'mcp-popular-icon', 'data-brand': 'playwright', 'aria-hidden': 'true' }, el('img', { alt: '', width: 20, height: 20, src: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjQwMCIgdmlld0JveD0iMCAwIDQwMCA0MDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik0xMzYuNDQ0IDIyMS41NTZDMTIzLjU1OCAyMjUuMjEzIDExNS4xMDQgMjMxLjYyNSAxMDkuNTM1IDIzOC4wMzJDMTE0Ljg2OSAyMzMuMzY0IDEyMi4wMTQgMjI5LjA4IDEzMS42NTIgMjI2LjM0OEMxNDEuNTEgMjIzLjU1NCAxNDkuOTIgMjIzLjU3NCAxNTYuODY5IDIyNC45MTVWMjE5LjQ4MUMxNTAuOTQxIDIxOC45MzkgMTQ0LjE0NSAyMTkuMzcxIDEzNi40NDQgMjIxLjU1NlpNMTA4Ljk0NiAxNzUuODc2TDYxLjA4OTUgMTg4LjQ4NEM2MS4wODk1IDE4OC40ODQgNjEuOTYxNyAxODkuNzE2IDYzLjU3NjcgMTkxLjM2TDEwNC4xNTMgMTgwLjY2OEMxMDQuMTUzIDE4MC42NjggMTAzLjU3OCAxODguMDc3IDk4LjU4NDcgMTk0LjcwNUMxMDguMDMgMTg3LjU1OSAxMDguOTQ2IDE3NS44NzYgMTA4Ljk0NiAxNzUuODc2Wk0xNDkuMDA1IDI4OC4zNDdDODEuNjU4MiAzMDYuNDg2IDQ2LjAyNzIgMjI4LjQzOCAzNS4yMzk2IDE4Ny45MjhDMzAuMjU1NiAxNjkuMjI5IDI4LjA3OTkgMTU1LjA2NyAyNy41IDE0NS45MjhDMjcuNDM3NyAxNDQuOTc5IDI3LjQ2NjUgMTQ0LjE3OSAyNy41MzM2IDE0My40NDZDMjQuMDQgMTQzLjY1NyAyMi4zNjc0IDE0NS40NzMgMjIuNzA3NyAxNTAuNzIxQzIzLjI4NzYgMTU5Ljg1NSAyNS40NjMzIDE3NC4wMTYgMzAuNDQ3MyAxOTIuNzIxQzQxLjIzMDEgMjMzLjIyNSA3Ni44NjU5IDMxMS4yNzMgMTQ0LjIxMyAyOTMuMTM0QzE1OC44NzIgMjg5LjE4NSAxNjkuODg1IDI4MS45OTIgMTc4LjE1MiAyNzIuODFDMTcwLjUzMiAyNzkuNjkyIDE2MC45OTUgMjg1LjExMiAxNDkuMDA1IDI4OC4zNDdaTTE2MS42NjEgMTI4LjExVjEzMi45MDNIMTg4LjA3N0MxODcuNTM1IDEzMS4yMDYgMTg2Ljk4OSAxMjkuNjc3IDE4Ni40NDcgMTI4LjExSDE2MS42NjFaIiBmaWxsPSIjMkQ0NTUyIi8+CjxwYXRoIGQ9Ik0xOTMuOTgxIDE2Ny41ODRDMjA1Ljg2MSAxNzAuOTU4IDIxMi4xNDQgMTc5LjI4NyAyMTUuNDY1IDE4Ni42NThMMjI4LjcxMSAxOTAuNDJDMjI4LjcxMSAxOTAuNDIgMjI2LjkwNCAxNjQuNjIzIDIwMy41NyAxNTcuOTk1QzE4MS43NDEgMTUxLjc5MyAxNjguMzA4IDE3MC4xMjQgMTY2LjY3NCAxNzIuNDk2QzE3My4wMjQgMTY3Ljk3MiAxODIuMjk3IDE2NC4yNjggMTkzLjk4MSAxNjcuNTg0Wk0yOTkuNDIyIDE4Ni43NzdDMjc3LjU3MyAxODAuNTQ3IDI2NC4xNDUgMTk4LjkxNiAyNjIuNTM1IDIwMS4yNTVDMjY4Ljg5IDE5Ni43MzYgMjc4LjE1OCAxOTMuMDMxIDI4OS44MzcgMTk2LjM2MkMzMDEuNjk4IDE5OS43NDEgMzA3Ljk3NiAyMDguMDYgMzExLjMwNyAyMTUuNDM2TDMyNC41NzIgMjE5LjIxMkMzMjQuNTcyIDIxOS4yMTIgMzIyLjczNiAxOTMuNDEgMjk5LjQyMiAxODYuNzc3Wk0yODYuMjYyIDI1NC43OTVMMTc2LjA3MiAyMjMuOTlDMTc2LjA3MiAyMjMuOTkgMTc3LjI2NSAyMzAuMDM4IDE4MS44NDIgMjM3Ljg2OUwyNzQuNjE3IDI2My44MDVDMjgyLjI1NSAyNTkuMzg2IDI4Ni4yNjIgMjU0Ljc5NSAyODYuMjYyIDI1NC43OTVaTTIwOS44NjcgMzIxLjEwMkMxMjIuNjE4IDI5Ny43MSAxMzMuMTY2IDE4Ni41NDMgMTQ3LjI4NCAxMzMuODY1QzE1My4wOTcgMTEyLjE1NiAxNTkuMDczIDk2LjAyMDMgMTY0LjAyOSA4NS4yMDRDMTYxLjA3MiA4NC41OTUzIDE1OC42MjMgODYuMTUyOSAxNTYuMjAzIDkxLjA3NDZDMTUwLjk0MSAxMDEuNzQ3IDE0NC4yMTIgMTE5LjEyNCAxMzcuNyAxNDMuNDVDMTIzLjU4NiAxOTYuMTI3IDExMy4wMzggMzA3LjI5IDIwMC4yODMgMzMwLjY4MkMyNDEuNDA2IDM0MS42OTkgMjczLjQ0MiAzMjQuOTU1IDI5Ny4zMjMgMjk4LjY1OUMyNzQuNjU1IDMxOS4xOSAyNDUuNzE0IDMzMC43MDEgMjA5Ljg2NyAzMjEuMTAyWiIgZmlsbD0iIzJENDU1MiIvPgo8cGF0aCBkPSJNMTYxLjY2MSAyNjIuMjk2VjIzOS44NjNMOTkuMzMyNCAyNTcuNTM3Qzk5LjMzMjQgMjU3LjUzNyAxMDMuOTM4IDIzMC43NzcgMTM2LjQ0NCAyMjEuNTU2QzE0Ni4zMDIgMjE4Ljc2MiAxNTQuNzEzIDIxOC43ODEgMTYxLjY2MSAyMjAuMTIzVjEyOC4xMUgxOTIuODY5QzE4OS40NzEgMTE3LjYxIDE4Ni4xODQgMTA5LjUyNiAxODMuNDIzIDEwMy45MDlDMTc4Ljg1NiA5NC42MTIgMTc0LjE3NCAxMDAuNzc1IDE2My41NDUgMTA5LjY2NUMxNTYuMDU5IDExNS45MTkgMTM3LjEzOSAxMjkuMjYxIDEwOC42NjggMTM2LjkzM0M4MC4xOTY2IDE0NC42MSA1Ny4xNzkgMTQyLjU3NCA0Ny41NzUyIDE0MC45MTFDMzMuOTYwMSAxMzguNTYyIDI2LjgzODcgMTM1LjU3MiAyNy41MDQ5IDE0NS45MjhDMjguMDg0NyAxNTUuMDYyIDMwLjI2MDUgMTY5LjIyNCAzNS4yNDQ1IDE4Ny45MjhDNDYuMDI3MiAyMjguNDMzIDgxLjY2MyAzMDYuNDgxIDE0OS4wMSAyODguMzQyQzE2Ni42MDIgMjgzLjYwMiAxNzkuMDE5IDI3NC4yMzMgMTg3LjYyNiAyNjIuMjkxSDE2MS42NjFWMjYyLjI5NlpNNjEuMDg0OCAxODguNDg0TDEwOC45NDYgMTc1Ljg3NkMxMDguOTQ2IDE3NS44NzYgMTA3LjU1MSAxOTQuMjg4IDg5LjYwODcgMTk5LjAxOEM3MS42NjE0IDIwMy43NDMgNjEuMDg0OCAxODguNDg0IDYxLjA4NDggMTg4LjQ4NFoiIGZpbGw9IiNFMjU3NEMiLz4KPHBhdGggZD0iTTM0MS43ODYgMTI5LjE3NEMzMjkuMzQ1IDEzMS4zNTUgMjk5LjQ5OCAxMzQuMDcyIDI2Mi42MTIgMTI0LjE4NUMyMjUuNzE2IDExNC4zMDQgMjAxLjIzNiA5Ny4wMjI0IDE5MS41MzcgODguODk5NEMxNzcuNzg4IDc3LjM4MzQgMTcxLjc0IDY5LjM4MDIgMTY1Ljc4OCA4MS40ODU3QzE2MC41MjYgOTIuMTYzIDE1My43OTcgMTA5LjU0IDE0Ny4yODQgMTMzLjg2NkMxMzMuMTcxIDE4Ni41NDMgMTIyLjYyMyAyOTcuNzA2IDIwOS44NjcgMzIxLjA5OEMyOTcuMDkzIDM0NC40NyAzNDMuNTMgMjQyLjkyIDM1Ny42NDQgMTkwLjIzOEMzNjQuMTU3IDE2NS45MTcgMzY3LjAxMyAxNDcuNSAzNjcuNzk5IDEzNS42MjVDMzY4LjY5NSAxMjIuMTczIDM1OS40NTUgMTI2LjA3OCAzNDEuNzg2IDEyOS4xNzRaTTE2Ni40OTcgMTcyLjc1NkMxNjYuNDk3IDE3Mi43NTYgMTgwLjI0NiAxNTEuMzcyIDIwMy41NjUgMTU4QzIyNi44OTkgMTY0LjYyOCAyMjguNzA2IDE5MC40MjUgMjI4LjcwNiAxOTAuNDI1TDE2Ni40OTcgMTcyLjc1NlpNMjIzLjQyIDI2OC43MTNDMTgyLjQwMyAyNTYuNjk4IDE3Ni4wNzcgMjIzLjk5IDE3Ni4wNzcgMjIzLjk5TDI4Ni4yNjIgMjU0Ljc5NkMyODYuMjYyIDI1NC43OTEgMjY0LjAyMSAyODAuNTc4IDIyMy40MiAyNjguNzEzWk0yNjIuMzc3IDIwMS40OTVDMjYyLjM3NyAyMDEuNDk1IDI3Ni4xMDcgMTgwLjEyNiAyOTkuNDIyIDE4Ni43NzNDMzIyLjczNiAxOTMuNDExIDMyNC41NzIgMjE5LjIwOCAzMjQuNTcyIDIxOS4yMDhMMjYyLjM3NyAyMDEuNDk1WiIgZmlsbD0iIzJFQUQzMyIvPgo8cGF0aCBkPSJNMTM5Ljg4IDI0Ni4wNEw5OS4zMzI0IDI1Ny41MzJDOTkuMzMyNCAyNTcuNTMyIDEwMy43MzcgMjMyLjQ0IDEzMy42MDcgMjIyLjQ5NkwxMTAuNjQ3IDEzNi4zM0wxMDguNjYzIDEzNi45MzNDODAuMTkxOCAxNDQuNjExIDU3LjE3NDIgMTQyLjU3NCA0Ny41NzA0IDE0MC45MTFDMzMuOTU1NCAxMzguNTYzIDI2LjgzNCAxMzUuNTcyIDI3LjUwMDEgMTQ1LjkyOUMyOC4wOCAxNTUuMDYzIDMwLjI1NTcgMTY5LjIyNCAzNS4yMzk3IDE4Ny45MjlDNDYuMDIyNSAyMjguNDMzIDgxLjY1ODMgMzA2LjQ4MSAxNDkuMDA1IDI4OC4zNDJMMTUwLjk4OSAyODcuNzE5TDEzOS44OCAyNDYuMDRaTTYxLjA4NDggMTg4LjQ4NUwxMDguOTQ2IDE3NS44NzZDMTA4Ljk0NiAxNzUuODc2IDEwNy41NTEgMTk0LjI4OCA4OS42MDg3IDE5OS4wMThDNzEuNjYxNSAyMDMuNzQzIDYxLjA4NDggMTg4LjQ4NSA2MS4wODQ4IDE4OC40ODVaIiBmaWxsPSIjRDY1MzQ4Ii8+CjxwYXRoIGQ9Ik0yMjUuMjcgMjY5LjE2M0wyMjMuNDE1IDI2OC43MTJDMTgyLjM5OCAyNTYuNjk4IDE3Ni4wNzIgMjIzLjk5IDE3Ni4wNzIgMjIzLjk5TDIzMi44OSAyMzkuODcyTDI2Mi45NzEgMTI0LjI4MUwyNjIuNjA3IDEyNC4xODVDMjI1LjcxMSAxMTQuMzA0IDIwMS4yMzIgOTcuMDIyNCAxOTEuNTMyIDg4Ljg5OTRDMTc3Ljc4MyA3Ny4zODM0IDE3MS43MzUgNjkuMzgwMiAxNjUuNzgzIDgxLjQ4NTdDMTYwLjUyNiA5Mi4xNjMgMTUzLjc5NyAxMDkuNTQgMTQ3LjI4NCAxMzMuODY2QzEzMy4xNzEgMTg2LjU0MyAxMjIuNjIzIDI5Ny43MDYgMjA5Ljg2NyAzMjEuMDk3TDIxMS42NTUgMzIxLjVMMjI1LjI3IDI2OS4xNjNaTTE2Ni40OTcgMTcyLjc1NkMxNjYuNDk3IDE3Mi43NTYgMTgwLjI0NiAxNTEuMzcyIDIwMy41NjUgMTU4QzIyNi44OTkgMTY0LjYyOCAyMjguNzA2IDE5MC40MjUgMjI4LjcwNiAxOTAuNDI1TDE2Ni40OTcgMTcyLjc1NloiIGZpbGw9IiMxRDhEMjIiLz4KPHBhdGggZD0iTTE0MS45NDYgMjQ1LjQ1MUwxMzEuMDcyIDI0OC41MzdDMTMzLjY0MSAyNjMuMDE5IDEzOC4xNjkgMjc2LjkxNyAxNDUuMjc2IDI4OS4xOTVDMTQ2LjUxMyAyODguOTIyIDE0Ny43NCAyODguNjg3IDE0OSAyODguMzQyQzE1Mi4zMDIgMjg3LjQ1MSAxNTUuMzY0IDI4Ni4zNDggMTU4LjMxMiAyODUuMTQ1QzE1MC4zNzEgMjczLjM2MSAxNDUuMTE4IDI1OS43ODkgMTQxLjk0NiAyNDUuNDUxWk0xMzcuNyAxNDMuNDUxQzEzMi4xMTIgMTY0LjMwNyAxMjcuMTEzIDE5NC4zMjYgMTI4LjQ4OSAyMjQuNDM2QzEzMC45NTIgMjIzLjM2NyAxMzMuNTU0IDIyMi4zNzEgMTM2LjQ0NCAyMjEuNTUxTDEzOC40NTcgMjIxLjEwMUMxMzYuMDAzIDE4OC45MzkgMTQxLjMwOCAxNTYuMTY1IDE0Ny4yODQgMTMzLjg2NkMxNDguNzk5IDEyOC4yMjUgMTUwLjMxOCAxMjIuOTc4IDE1MS44MzIgMTE4LjA4NUMxNDkuMzkzIDExOS42MzcgMTQ2Ljc2NyAxMjEuMjI4IDE0My43NzYgMTIyLjg2N0MxNDEuNzU5IDEyOS4wOTMgMTM5LjcyMiAxMzUuODk4IDEzNy43IDE0My40NTFaIiBmaWxsPSIjQzA0QjQxIi8+Cjwvc3ZnPgo=' }));
    const art = brand ? el('img', {
      alt: '', width: 20, height: 20,
      src: 'data:image/svg+xml,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${brand.color}" d="${brand.path}"/></svg>`),
    }) : icon(SERVICE_ICONS[id] || 'plug');
    return el('span', { class: 'mcp-popular-icon', 'data-brand': brand ? id : null, 'aria-hidden': 'true' }, art);
  }

  let mail = null;
  let mailConnecting = false;

  const POPULAR_CATS = [
    { id: 'all', title: 'Все' },
    { id: 'dev', title: 'Разработка' },
    { id: 'other', title: 'Прочее', full: 'Прочее' },
  ];

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') node.textContent = String(v);
      else if (k === 'class') node.setAttribute('class', String(v));
      else if (k === 'checked') node.checked = v;
      else if (k === 'disabled') node.disabled = v;
      else if (k === 'hidden') node.hidden = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
    node.append(...kids.filter(Boolean));
    return node;
  };
  const icon = (name) => el('span', { class: '', 'data-icon': name, 'aria-hidden': 'true' });
  const fillIcons = (node) => {
    const ui = window.JarvisUI;
    if (ui && typeof ui.fillIcons === 'function') ui.fillIcons(node);
  };
  const toast = (text, kind) => document.dispatchEvent(new CustomEvent('jarvis:toast', { detail: { text, kind } }));
  const bridge = () => (window.jarvis && window.jarvis.mcpState ? window.jarvis : null);
  const plural = (n, forms) => {
    const v = Math.abs(Number(n) || 0) % 100;
    const d = v % 10;
    if (v > 10 && v < 20) return forms[2];
    if (d === 1) return forms[0];
    if (d >= 2 && d <= 4) return forms[1];
    return forms[2];
  };

  // ── Состояние экрана ──────────────────────────────────────────
  const STATE = { q: '', filter: 'all', popularCat: 'all' };
  let SERVERS = [];
  let LOAD_ERROR = '';
  let listKey = '';
  let popularKey = '';
  let lastTrigger = null;

  // Статус сервиса: новые поля status/error, старые connected/disabled — тот же смысл.
  // Незнакомый статус не показываем как «Настроено»: честнее «старая сборка моста».
  function statusOf(server) {
    let status = null;
    if (server && server.status) status = String(server.status);
    else if (server && server.disabled) status = 'disabled';
    else if (server && server.connected) status = 'connected';
    else status = 'legacy';
    return STATUS[status] ? status : 'legacy';
  }

  // Тексты и цвета состояний. Слова различимы без цвета (важно для a11y).
  // Пилюля всегда называет одно из четырёх достоверных состояний; подсказка внутри состояния
  // («Выключен», «Подключается», «Изменения инструментов») живёт в строке состояния ниже.
  const STATUS = {
    connected: { word: 'Подключён', tone: 'ok' },
    connecting: { word: 'Подключается', tone: 'accent' },
    disabled: { word: 'Настроено', tone: 'ghost' },
    idle: { word: 'Настроено', tone: 'muted' },
    legacy: { word: 'Настроено', tone: 'muted' },
    error: { word: 'Ошибка', tone: 'err' },
    drift: { word: 'Изменения инструментов', tone: 'warn' },
  };

  // Четыре достоверных состояния раздела (М2): «Предложено» — запись каталога, которой ещё нет
  // в настройках; «Настроено» — сервис сохранён, но соединения нет (выключен, ещё не запускался,
  // старая сборка); «Подключено» — живое соединение (включая «Подключается» и ожидание
  // подтверждения изменений); «Ошибка» — сохранить удалось, соединиться нет.
  // Группа — единственный источник правды: пилюля, счётчики и итоги действий смотрят только
  // на неё, поэтому сервис не может выглядеть подключённым без фактического соединения.
  const CONNECTED_STATUSES = ['connected', 'connecting', 'drift'];
  function groupOf(server) {
    const status = statusOf(server);
    if (status === 'error') return 'error';
    if (CONNECTED_STATUSES.includes(status)) return 'connected';
    return 'configured';
  }

  function statusInfo(server) {
    return STATUS[statusOf(server)] || STATUS.idle;
  }

  // Пилюля состояния: одна и та же в списке, деталях и панели популярных.
  const pillOf = (word, tone) => el('span', { class: 'mcp-pill', 'data-tone': tone },
    el('span', { class: 'mcp-pill-dot', 'aria-hidden': 'true' }), el('span', { text: word }));
  const statusPill = (server) => { const info = statusInfo(server); return pillOf(info.word, info.tone); };

  // Причина ошибки понятным русским. Исходный текст остаётся рядом («Подробнее», диалог),
  // объяснение его не подменяет.
  function explainError(raw) {
    const text = String(raw || '').trim();
    if (!text) return 'Причина не сообщена. Проверьте команду или адрес сервиса и повторите.';
    const low = text.toLowerCase();
    if (low.includes('enoent') || low.includes('не найден') || low.includes('not found')) {
      return 'Не удалось запустить: программы из команды нет на этом компьютере.';
    }
    if (low.includes('eacces') || low.includes('eperm') || low.includes('отказано')) {
      return 'Не удалось запустить: у Windows нет прав на эту программу или папку.';
    }
    if (low.includes('enotfound') || low.includes('econnrefused') || low.includes('econnreset') || low.includes('network') || low.includes('fetch failed')) {
      return 'Не удалось достучаться до сервиса: проверьте адрес и подключение к сети.';
    }
    if (low.includes('timeout') || low.includes('не ответил') || low.includes('истекло')) {
      return 'Сервис не ответил за отведённое время. Возможно, он занят или сеть медленная.';
    }
    if (low.includes('401') || low.includes('403') || low.includes('unauthorized')) {
      return 'Сервис отклонил соединение: проверьте адрес и ключ доступа в настройках сервиса.';
    }
    return text;
  }

  // Права до включения: что сервис получит после соединения. Список действий до соединения
  // неизвестен — не выдумываем его, показываем права и честно говорим, что появится после проверки.
  function catalogEntry(server) {
    if (!verifiedCatalog || !server || !server.name) return null;
    return verifiedCatalog.find((entry) => entry && entry.id === server.name) || null;
  }

  function rightsOf(server) {
    const entry = catalogEntry(server);
    const scope = (entry && entry.description && String(entry.description)) || (server.transport === 'http'
      ? 'доступ по указанному адресу в интернете'
      : 'запуск указанной программы на этом компьютере');
    return {
      scope,
      policy: 'Подключение не расширяет права приложения: действия сервиса спрашиваются по общим правилам, пока вы не разрешите их в настройках.',
    };
  }

  // Проверка перехода: итог действия читаем из фактического состояния в ответе ядра,
  // а не из одного «ok». «Подключён» говорим только когда группа действительно «Подключено».
  function findServer(servers, name) {
    return (Array.isArray(servers) ? servers : []).find((x) => x && x.name === name) || null;
  }

  function outcomeOf(name, servers) {
    const fresh = findServer(servers, name);
    if (!fresh) return null;
    const group = groupOf(fresh);
    if (group === 'connected') return { kind: 'ok', text: `Сервис «${name}» подключён` };
    if (group === 'error') return { kind: 'error', text: `Сервис «${name}» сохранён, но не подключился: ${explainError(fresh.error)}` };
    if (statusOf(fresh) === 'disabled') return { kind: 'ok', text: `Сервис «${name}» выключен, его действия больше не доступны` };
    return { kind: 'ok', text: `Сервис «${name}» настроен, соединения ещё нет` };
  }

  // Что сервис умеет: имена действий (не внутренние имена модели) или объявленные возможности.
  function capabilitiesText(server) {
    if (!server || statusOf(server) === 'error') return null;
    // До фактического соединения набор действий неизвестен: «настроено» не выдаём за «умеет».
    if (groupOf(server) !== 'connected') return null;
    const tools = Array.isArray(server.tools) ? server.tools : [];
    if (tools.length) {
      const titles = tools.slice(0, 4).map((tool) => String((tool && (tool.title || tool.name)) || '').trim()).filter(Boolean);
      const tail = tools.length > titles.length ? ` и ещё ${tools.length - titles.length}` : '';
      return `Действия (${tools.length}): ${titles.join(', ')}${tail}`;
    }
    const caps = server.capabilities && typeof server.capabilities === 'object' ? server.capabilities : null;
    if (caps) {
      const words = [caps.tools && 'инструменты', caps.resources && 'ресурсы', caps.prompts && 'подсказки', caps.logging && 'журнал'].filter(Boolean);
      return words.length ? `Возможности: ${words.join(', ')}` : 'Возможности не объявлены';
    }
    if (statusOf(server) === 'connected') return 'Инструментов нет';
    return null;
  }

  // Служебная подпись: протокол и имя сервера. В карточке — title, в деталях — строка.
  function detailsTitle(server) {
    if (!server) return '';
    const parts = [];
    if (server.protocolVersion) parts.push(`Протокол MCP ${server.protocolVersion}`);
    const info = server.serverInfo && typeof server.serverInfo === 'object' ? server.serverInfo : null;
    if (info && info.name) parts.push(`Сервер: ${info.name}${info.version ? ` ${info.version}` : ''}`);
    return parts.join(' · ');
  }

  // Строка состояния под адресом: как в макете — «Подключён · 8 действий» и т. п.
  function statusLine(server) {
    const status = statusOf(server);
    if (status === 'connected') {
      const n = Number(server.toolCount) || (Array.isArray(server.tools) ? server.tools.length : 0);
      return `Подключён · ${n} ${plural(n, ['действие', 'действия', 'действий'])}`;
    }
    if (status === 'connecting') return 'Подключается…';
    if (status === 'disabled') return 'Выключен · соединения нет, действия недоступны';
    if (status === 'idle') return 'Настроено · сохранено, но ещё не подключалось';
    if (status === 'legacy') return 'Подключится при запуске';
    if (status === 'error') return `Ошибка: ${String(server.error || 'причина не сообщена')}`;
    if (status === 'drift') return 'Набор действий изменился — нужно ваше подтверждение';
    return '';
  }

  function driftItems(server) {
    const d = server && server.drift && typeof server.drift === 'object' ? server.drift : {};
    const out = [];
    if (Array.isArray(d.added)) for (const name of d.added.slice(0, 4)) out.push({ kind: 'added', text: `+ ${name}` });
    if (Array.isArray(d.removed)) for (const name of d.removed.slice(0, 4)) out.push({ kind: 'removed', text: `− ${name}` });
    if (Array.isArray(d.changed)) {
      for (const item of d.changed.slice(0, 4)) {
        const name = item && typeof item === 'object' ? item.name : item;
        if (name) out.push({ kind: 'changed', text: `~ ${name}` });
      }
    }
    return out;
  }

  // ── Диалоги: открытие/закрытие, возврат фокуса ─────────────────
  const triggers = new Map();

  function openDialog(dialog, trigger) {
    if (!dialog) return false;
    if (trigger) triggers.set(dialog, trigger);
    try {
      if (typeof dialog.showModal === 'function' && dialog.open !== true) dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch {
      dialog.setAttribute('open', '');
    }
    return true;
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    try {
      if (typeof dialog.close === 'function' && dialog.open === true) dialog.close();
      else if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    } catch {
      dialog.removeAttribute('open');
    }
    const back = triggers.get(dialog);
    triggers.delete(dialog);
    let target = back;
    // Карточка могла перерисоваться опросом, пока диалог был открыт: ищем свежую по имени.
    if (target && typeof target.isConnected === 'boolean' && target.isConnected === false) {
      const name = dialog.dataset ? String(dialog.dataset.name || '') : '';
      target = name && typeof document.querySelector === 'function'
        ? document.querySelector(`#mcpList .mcp-card[data-name="${name.replace(/["\\]/g, '')}"]`)
        : null;
    }
    if (target && typeof target.focus === 'function') {
      try { target.focus(); } catch { /* элемент уже не на экране */ }
    }
  }

  function focusFirst(selector) {
    const node = $(selector);
    if (node && typeof node.focus === 'function') node.focus();
  }

  // ── Список подключений ────────────────────────────────────────
  function searchText(server) {
    return [
      server.name,
      server.target,
      statusInfo(server).word,
      capabilitiesText(server) || '',
      detailsTitle(server) || '',
    ].join(' ').toLowerCase();
  }

  function filteredServers() {
    const q = STATE.q.trim().toLowerCase();
    return SERVERS.filter((server) => {
      const group = groupOf(server);
      if (STATE.filter === 'connected' && group !== 'connected') return false;
      if (STATE.filter === 'disabled' && group !== 'configured') return false;
      if (STATE.filter === 'error' && group !== 'error') return false;
      if (!q) return true;
      return searchText(server).includes(q);
    });
  }

  function cardButton(server, status, api) {
    if (status === 'connected') {
      return el('button', {
        class: 'mcp-card-action', type: 'button', 'data-focus-key': `details:${server.name}`,
        text: 'Детали',
        onclick: (e) => { e.stopPropagation(); openDetails(server, e.currentTarget); },
      });
    }
    if (status === 'connecting') {
      const b = el('button', { class: 'mcp-card-action', type: 'button', disabled: true });
      b.append(el('span', { class: 'mcp-spinner', 'aria-hidden': 'true' }), el('span', { text: 'Подключается' }));
      return b;
    }
    if (status === 'disabled' || status === 'idle') {
      return el('button', {
        class: 'mcp-card-action', type: 'button', 'data-focus-key': `toggle:${server.name}`,
        disabled: !api, text: 'Включить',
        onclick: (e) => { e.stopPropagation(); toggleServer(server, false, e.currentTarget); },
      });
    }
    if (status === 'error') {
      return el('button', {
        class: 'mcp-card-action mcp-card-action-err', type: 'button', 'data-focus-key': `retry:${server.name}`,
        disabled: !api, text: 'Повторить',
        onclick: (e) => { e.stopPropagation(); retryServer(server, e.currentTarget); },
      });
    }
    if (status === 'drift') {
      return el('button', {
        class: 'mcp-card-action mcp-card-action-accent', type: 'button', 'data-focus-key': `approve:${server.name}`,
        disabled: !api, text: 'Подтвердить изменения',
        onclick: (e) => { e.stopPropagation(); openDrift(server, e.currentTarget); },
      });
    }
    return null;
  }

  function card(server) {
    const api = bridge();
    const status = statusOf(server);
    const info = statusInfo(server);
    const title = detailsTitle(server);
    const action = cardButton(server, status, api);

    const top = el('div', { class: 'mcp-card-top' },
      el('span', { class: 'mcp-name', title: title || server.name, text: String(server.name || '') }),
      el('span', { class: 'mcp-pill', 'data-tone': info.tone },
        el('span', { class: 'mcp-pill-dot', 'aria-hidden': 'true' }),
        el('span', { text: info.word })));

    const main = el('div', { class: 'mcp-card-main' }, top);
    const transport = server.transport === 'http' ? 'адрес' : 'команда';
    const technical = el('details', { class: 'collection-details mcp-technical' },
      el('summary', { text: 'Подробнее' }),
      el('p', { text: `${transport}: ${String(server.target || '')}` }));

    const line = el('div', {
      class: 'mcp-line'
        + (status === 'error' ? ' mcp-line-error' : '')
        + (status === 'drift' ? ' mcp-line-warn' : ''),
      text: status === 'error' ? explainError(server.error) : statusLine(server),
    });
    main.append(line);
    // Исходная техническая причина остаётся рядом: объяснение её не подменяет и не прячет.
    if (status === 'error') technical.append(el('p', { text: statusLine(server) }));

    // Права до включения: что сервис получит, видно ещё до соединения.
    if (groupOf(server) !== 'connected') {
      main.append(el('div', { class: 'mcp-rights', text: `Права: ${rightsOf(server).scope}` }));
    }

    const caps = capabilitiesText(server);
    if (caps) main.append(el('div', { class: 'mcp-caps', text: caps }));

    if (status === 'drift') {
      const chips = driftItems(server);
      if (chips.length) {
        technical.append(el('div', { class: 'mcp-diff' }, ...chips.map((item) => el('span', {
          class: 'mcp-diff-chip', 'data-kind': item.kind, text: item.text,
        }))));
      }
    }

    main.append(technical);

    const actions = el('div', { class: 'mcp-card-actions' });
    if (action) actions.append(action);

    const node = el('li', {
      class: 'mcp-card', 'data-name': String(server.name || ''), 'data-status': status,
      'data-group': groupOf(server),
      'data-focus-key': `card:${server.name}`,
      tabindex: '0', role: 'group', 'aria-label': `${server.name}: ${info.word}`,
    }, el('span', { class: 'mcp-icon', 'aria-hidden': 'true' }, icon('plug')), main, actions);

    node.addEventListener('click', (e) => {
      if (e && e.target && typeof e.target.closest === 'function' && e.target.closest('button, input, a, canvas, details')) return;
      openDetails(server, node);
    });
    node.addEventListener('keydown', (e) => {
      if (!e || (e.key !== 'Enter' && e.key !== ' ')) return;
      if (e.target !== node) return;
      e.preventDefault();
      openDetails(server, node);
    });
    return node;
  }

  function restoreListFocus() {
    const active = document.activeElement;
    if (!active || typeof active.getAttribute !== 'function') return;
    const key = active.getAttribute('data-focus-key');
    if (!key || typeof list.querySelector !== 'function') return;
    let again = null;
    try { again = list.querySelector(`[data-focus-key="${key}"]`); } catch { again = null; }
    if (!again && key.startsWith('card:')) {
      const name = key.slice(5);
      try { again = list.querySelector(`.mcp-card[data-name="${name}"]`); } catch { again = null; }
    }
    if (again && typeof again.focus === 'function') again.focus();
  }

  // Подпись чипа фильтра приводим к четырём достоверным состояниям, счёт одной правдой (groupOf).
  function setChipWord(chip, word) {
    if (!chip || !chip.childNodes) return;
    for (const kid of chip.childNodes) {
      if (kid && kid.nodeType === 3) { kid.nodeValue = `${word} `; return; }
    }
  }

  function renderCounts() {
    const counts = { all: SERVERS.length, connected: 0, configured: 0, error: 0 };
    for (const server of SERVERS) {
      const group = groupOf(server);
      if (group === 'connected') counts.connected += 1;
      else if (group === 'error') counts.error += 1;
      else counts.configured += 1;
    }
    const map = { mcpFilterAllCount: counts.all, mcpFilterConnectedCount: counts.connected, mcpFilterDisabledCount: counts.configured, mcpFilterErrorCount: counts.error };
    for (const [id, value] of Object.entries(map)) {
      const node = $(id);
      if (node) node.textContent = String(value);
    }
    const chips = document.querySelectorAll ? document.querySelectorAll('#mcpFilters .nox-chip-filter') : [];
    for (const chip of chips) {
      const filter = chip.getAttribute('data-filter');
      chip.setAttribute('aria-pressed', String(filter === STATE.filter));
      if (filter === 'connected') setChipWord(chip, 'Подключённые');
      else if (filter === 'disabled') setChipWord(chip, 'Настроенные');
    }
  }

  function renderList() {
    const filtered = filteredServers();
    const key = JSON.stringify(filtered) + '|' + STATE.q + '|' + STATE.filter + '|' + LOAD_ERROR;
    if (key === listKey) return;
    listKey = key;
    restoreListFocus();
    list.replaceChildren(...filtered.map(card));
    fillIcons(list);

    const noResults = $('mcpNoResults');
    const isEmpty = SERVERS.length === 0;
    const hasFilter = Boolean(STATE.q.trim()) || STATE.filter !== 'all';
    empty.hidden = !(isEmpty && !LOAD_ERROR);
    if (noResults) noResults.hidden = !(filtered.length === 0 && !isEmpty && hasFilter && !LOAD_ERROR);
    const loading = $('mcpLoading');
    if (loading) loading.hidden = true;
    const errNote = $('mcpErrorNote');
    if (errNote) errNote.hidden = !LOAD_ERROR;
    const errText = $('mcpErrorText');
    if (errText) errText.textContent = LOAD_ERROR;
  }

  function renderLoadError() {
    listKey = '';
    renderList();
  }

  // ── Действия с сервисом ───────────────────────────────────────
  async function toggleServer(server, disabled, button) {
    const api = bridge();
    if (!api) return;
    if (button) button.disabled = true;
    let r;
    try {
      r = await api.mcpToggle(server.name, disabled === true);
    } catch (err) {
      if (button) button.disabled = false;
      toast('Не получилось: ' + String((err && err.message) || err), 'error');
      return;
    }
    if (button) button.disabled = false;
    if (r && r.servers) paint(r.servers);
    if (!r || !r.ok) { toast(explainError((r && r.error) || 'Не получилось'), 'error'); return; }
    if (r.error) { toast(explainError(r.error), 'error'); return; }
    if (disabled) { toast(`Сервис «${server.name}» выключен, его действия больше не доступны`, 'ok'); return; }
    // Итог включения читаем из фактического состояния сервиса, а не из одного «ok».
    const outcome = outcomeOf(server.name, (r && r.servers) || SERVERS);
    toast(outcome ? outcome.text : `Сервис «${server.name}» сохранён, соединения ещё нет`, outcome ? outcome.kind : 'ok');
  }

  async function retryServer(server, button) {
    const api = bridge();
    if (!api) return;
    lastTrigger = button || lastTrigger;
    if (button) button.disabled = true;
    let r;
    try {
      r = await api.mcpToggle(server.name, false);
    } catch (err) {
      if (button) button.disabled = false;
      openConnectError(server.name, String((err && err.message) || err), button);
      return;
    }
    if (button) button.disabled = false;
    if (r && r.servers) paint(r.servers);
    if (!r || !r.ok) { openConnectError(server.name, (r && r.error) || 'не получилось переподключить', button); return; }
    if (r.error) { openConnectError(server.name, String(r.error), button); return; }
    // «Подключён» говорим только если сервис действительно подключился.
    const fresh = findServer(r.servers, server.name);
    if (fresh && groupOf(fresh) === 'connected') {
      toast(`Сервис «${server.name}» подключён`, 'ok');
      return;
    }
    openConnectError(server.name, (fresh && fresh.error) || 'сервис не сообщил соединение', button);
  }

  function openConnectError(name, reason, trigger) {
    const dialog = $('mcpErrorDialog');
    if (!dialog) return;
    lastTrigger = trigger || lastTrigger;
    const plain = explainError(reason);
    const nameNode = $('mcpConnErrName');
    if (nameNode) {
      const head = `Сервис «${name}» сохранён, но не подключился.`;
      // Если причина уже понятна словами — объяснение рядом, исходный текст ниже не подменяется.
      nameNode.textContent = plain && plain !== String(reason || '').trim() ? `${head} ${plain}` : head;
    }
    const reasonNode = $('mcpConnErrReason');
    if (reasonNode) reasonNode.textContent = String(reason || 'причина не сообщена');
    dialog.dataset.name = name;
    openDialog(dialog, trigger);
    focusFirst('mcpConnErrRetry');
  }

  // ── Детали сервиса ────────────────────────────────────────────
  let detailName = '';

  function detailPill(server) {
    const info = statusInfo(server);
    return el('span', { class: 'mcp-pill', 'data-tone': info.tone },
      el('span', { class: 'mcp-pill-dot', 'aria-hidden': 'true' }),
      el('span', { text: info.word }));
  }

  function renderDetails(server) {
    const body = $('mcpDetailsBody');
    if (!body || !server) return;
    detailName = server.name;
    const title = $('mcpDetailsTitle');
    if (title) title.textContent = server.name;
    const status = statusOf(server);
    const info = statusInfo(server);
    const meta = detailsTitle(server);
    const parts = [];

    parts.push(el('div', { class: 'mcp-detail-head' },
      el('span', { class: 'mcp-detail-name', text: String(server.name || '') }),
      detailPill(server)));
    if (meta) parts.push(el('div', { class: 'mcp-detail-meta', text: meta }));
    // Состояние словами: четыре достоверных состояния, без догадок.
    const group = groupOf(server);
    parts.push(el('div', { class: 'mcp-detail-status', 'data-group': group,
      text: group === 'error' ? explainError(server.error) : statusLine(server) }));

    const transport = server.transport === 'http' ? 'Адрес' : 'Команда';
    const targetBox = el('div', { class: 'mcp-target-box' },
      el('code', { title: String(server.target || ''), text: String(server.target || '') }));
    targetBox.append(el('button', {
      class: 'nox-icon-btn', type: 'button', title: `${transport} — скопировать`, 'aria-label': `${transport} — скопировать`,
      onclick: async () => {
        const ok = await copyText(String(server.target || ''));
        toast(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'ok' : 'error');
      },
    }, icon('clip')));
    parts.push(el('div', { class: 'mcp-detail-section' },
      el('div', { class: 'mcp-detail-section-title', text: transport === 'Адрес' ? 'Адрес сервиса' : 'Команда запуска' }),
      targetBox));

    const tools = Array.isArray(server.tools) ? server.tools : [];
    const capsChips = tools.slice(0, 12).map((tool) => String((tool && (tool.title || tool.name)) || '').trim()).filter(Boolean);
    if (capsChips.length) {
      const cats = el('div', { class: 'mcp-detail-cats' }, ...capsChips.map((text) => el('span', { class: 'mcp-cap-chip', title: text, text })));
      if (tools.length > capsChips.length) cats.append(el('span', { class: 'mcp-cap-chip', text: `и ещё ${tools.length - capsChips.length}` }));
      parts.push(el('div', { class: 'mcp-detail-section' },
        el('div', { class: 'mcp-detail-section-title', text: `Действия сервиса (${tools.length})` }), cats));
    } else if (status === 'connected') {
      parts.push(el('div', { class: 'mcp-detail-section' },
        el('div', { class: 'mcp-detail-section-title', text: 'Действия сервиса' }),
        el('p', { class: 'mcp-detail-text', text: 'Сервис не сообщил список действий.' })));
    }

    if (status === 'error' && server.error) {
      parts.push(el('p', { class: 'mcp-dialog-error', 'data-server-error': 'true' },
        icon('alert'), el('span', { text: String(server.error) })));
    }
    if (status === 'drift') {
      const chips = driftItems(server);
      parts.push(el('div', { class: 'mcp-detail-section' },
        el('div', { class: 'mcp-detail-section-title', text: 'Набор действий изменился' }),
        el('p', { class: 'mcp-detail-text', text: 'Пока изменения не подтверждены, действия сервиса недоступны. Подтверждение — в карточке сервиса.' }),
        chips.length ? el('div', { class: 'mcp-diff' }, ...chips.map((item) => el('span', { class: 'mcp-diff-chip', 'data-kind': item.kind, text: item.text }))) : null));
    }

    const rights = rightsOf(server);
    parts.push(el('div', { class: 'mcp-detail-section' },
      el('div', { class: 'mcp-detail-section-title', text: group === 'connected' ? 'Разрешения' : 'Разрешения до включения' }),
      el('p', { class: 'mcp-detail-text mcp-rights-scope' },
        el('b', { text: 'Что получит сервис: ' }), `${rights.scope}.`),
      el('p', { class: 'mcp-detail-text' },
        el('b', { text: 'Подключение не расширяет права приложения. ' }),
        'Действия сервиса проходят общую политику Nox: перед изменяющими системными действиями Джарвис спросит вас. Подтверждение набора действий сервиса — отдельное решение и не разрешает агенту системные действия.')));

    const sw = el('input', {
      type: 'checkbox', role: 'switch', class: 'switch', id: 'mcpDetailsToggle',
      'aria-label': `Сервис «${server.name}» включён`,
    });
    sw.checked = server.disabled !== true;
    sw.disabled = !bridge();
    sw.addEventListener('change', async () => {
      const api = bridge();
      if (!api) { sw.checked = !sw.checked; return; }
      sw.disabled = true;
      let r;
      try {
        r = await api.mcpToggle(server.name, !sw.checked);
      } catch (err) {
        sw.checked = !sw.checked;
        sw.disabled = false;
        toast('Не получилось: ' + String((err && err.message) || err), 'error');
        return;
      }
      sw.disabled = false;
      if (!r || !r.ok) { sw.checked = !sw.checked; toast((r && r.error) || 'Не получилось', 'error'); return; }
      if (r.error) toast(String(r.error), 'error');
      if (r.servers) {
        paint(r.servers, { force: true });
        const fresh = (Array.isArray(r.servers) ? r.servers : []).find((x) => x.name === server.name);
        if (fresh) renderDetails(fresh);
      }
    });
    const hint = server.disabled === true
      ? 'Действия недоступны, пока не включите'
      : group === 'connected' ? 'Действия доступны после вашего разрешения'
        : group === 'error' ? 'Сохранён, но соединения нет — действия недоступны'
          : 'Сохранён: действия появятся после соединения';
    parts.push(el('div', { class: 'mcp-toggle-row' },
      el('span', { class: 'mcp-toggle-text' },
        el('span', { class: 'mcp-toggle-name', text: server.disabled === true ? 'Сервис выключен' : 'Сервис включён' }),
        el('span', { class: 'mcp-toggle-hint', text: hint })),
      sw));

    body.replaceChildren(...parts.filter(Boolean));
    fillIcons(body);
    const errorNode = $('mcpDetailsError');
    if (errorNode) errorNode.hidden = true;
    const deleteBtn = $('mcpDetailsDelete');
    if (deleteBtn) deleteBtn.disabled = !bridge();
  }

  function openDetails(server, trigger) {
    const dialog = $('mcpDetailsDialog');
    if (!dialog || !server) return;
    lastTrigger = trigger || null;
    renderDetails(server);
    openDialog(dialog, trigger);
    focusFirst('mcpDetailsClose');
  }

  // ── Удаление ──────────────────────────────────────────────────
  let deleteName = '';

  function openDelete(server) {
    const dialog = $('mcpDeleteDialog');
    if (!dialog || !server) return;
    deleteName = server.name;
    const text = $('mcpDeleteText');
    if (text) text.textContent = `Удалить «${server.name}»? Это действие нельзя отменить: сервис и его настройки будут удалены.`;
    const input = $('mcpDeleteInput');
    if (input) input.value = '';
    const confirm = $('mcpDeleteConfirm');
    if (confirm) confirm.disabled = true;
    const err = $('mcpDeleteError');
    if (err) err.hidden = true;
    openDialog(dialog, lastTrigger);
    if (input) input.focus();
  }

  async function confirmDelete() {
    const api = bridge();
    const dialog = $('mcpDeleteDialog');
    if (!api || !deleteName) return;
    const confirm = $('mcpDeleteConfirm');
    if (confirm) confirm.disabled = true;
    let r;
    try {
      r = await api.mcpRemove(deleteName);
    } catch (err) {
      if (confirm) confirm.disabled = false;
      showDeleteError(String((err && err.message) || err));
      return;
    }
    if (!r || !r.ok) {
      if (confirm) confirm.disabled = false;
      showDeleteError((r && r.error) || 'не получилось удалить');
      return;
    }
    if (r.servers) paint(r.servers, { force: true });
    closeDialog(dialog);
    closeDialog($('mcpDetailsDialog'));
    toast('Сервис удалён, его действия больше не доступны', 'ok');
    deleteName = '';
  }

  function showDeleteError(text) {
    const box = $('mcpDeleteError');
    const textNode = $('mcpDeleteErrorText');
    if (textNode) textNode.textContent = text;
    if (box) box.hidden = !text;
  }

  // ── Изменения набора действий (drift) ─────────────────────────
  let driftName = '';

  function openDrift(server, trigger) {
    const dialog = $('mcpDriftDialog');
    if (!dialog || !server) return;
    driftName = server.name;
    lastTrigger = trigger || null;
    const title = $('mcpDriftTitle');
    if (title) title.textContent = `Набор действий «${server.name}» изменился`;
    const text = $('mcpDriftText');
    if (text) {
      text.textContent = 'Сервис после обновления объявил другой набор действий. Сверьте изменения и подтвердите их, чтобы Джарвис снова мог пользоваться сервисом.';
    }
    const body = $('mcpDriftBody');
    if (body) {
      const chips = driftItems(server);
      body.replaceChildren(...(chips.length
        ? chips.map((item) => el('span', { class: 'mcp-diff-chip', 'data-kind': item.kind, text: item.text }))
        : [el('span', { class: 'mcp-diff-chip', text: 'изменения не перечислены сервисом' })]));
    }
    const err = $('mcpDriftError');
    if (err) err.hidden = true;
    openDialog(dialog, trigger);
    focusFirst('mcpDriftCancel');
  }

  async function confirmDrift() {
    const api = bridge();
    if (!api || !driftName) return;
    const button = $('mcpDriftConfirm');
    if (button) button.disabled = true;
    let r;
    try {
      r = await api.mcpApprove(driftName);
    } catch (err) {
      if (button) button.disabled = false;
      showDriftError(String((err && err.message) || err));
      return;
    }
    if (button) button.disabled = false;
    if (!r || !r.ok) { showDriftError((r && r.error) || 'не получилось подтвердить'); return; }
    if (r.servers) paint(r.servers, { force: true });
    closeDialog($('mcpDriftDialog'));
    toast('Изменения подтверждены: действия сервиса снова доступны', 'ok');
    driftName = '';
  }

  function showDriftError(text) {
    const box = $('mcpDriftError');
    const textNode = $('mcpDriftErrorText');
    if (textNode) textNode.textContent = text;
    if (box) box.hidden = !text;
  }

  // ── Добавление сервиса ────────────────────────────────────────
  const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

  function validateAdd(name, target, args) {
    if (!name) return 'Укажите название: латиница, цифры, «-» и «_», до 40 знаков';
    if (!NAME_RE.test(name)) return 'Название: латиница, цифры, «-» и «_», до 40 знаков';
    if (!target) return 'Укажите адрес или команду запуска';
    if (target.length > 400) return 'Адрес или команда длиннее 400 знаков';
    if (args.length > 400) return 'Аргументы длиннее 400 знаков';
    return '';
  }

  function showAddError(text) {
    const box = $('mcpAddError');
    const textNode = $('mcpAddErrorText');
    if (textNode) textNode.textContent = text || '';
    if (box) box.hidden = !text;
  }

  function updateAddValidity() {
    const nameNode = $('mcpName');
    const targetNode = $('mcpTarget');
    const argsNode = $('mcpArgs');
    const button = $('mcpAddSubmit');
    if (!button) return;
    const name = nameNode ? String(nameNode.value || '').trim() : '';
    const target = targetNode ? String(targetNode.value || '').trim() : '';
    const args = argsNode ? String(argsNode.value || '').trim() : '';
    button.disabled = Boolean(validateAdd(name, target, args));
    if (nameNode) nameNode.setAttribute('aria-invalid', String(Boolean(name) && !NAME_RE.test(name)));
  }

  function openAdd(trigger) {
    const dialog = $('mcpAddDialog');
    if (!dialog) return;
    lastTrigger = trigger || null;
    showAddError('');
    try { form.reset(); } catch { /* форма уже пуста */ }
    updateAddValidity();
    openDialog(dialog, trigger);
    focusFirst('mcpName');
  }

  form.addEventListener('submit', async (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const api = bridge();
    if (!api) return;
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const target = String(data.get('target') || '').trim();
    const args = String(data.get('args') || '').trim();
    const problem = validateAdd(name, target, args);
    if (problem) { showAddError(problem); return; }
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      const r = await api.mcpAdd(name, target, args);
      if (!r || !r.ok) {
        const why = (r && r.error) || 'Не получилось добавить';
        showAddError(why);
        toast(why, 'error');
        return;
      }
      if (r.servers) paint(r.servers, { force: true });
      try { form.reset(); } catch { /* форма уже пуста */ }
      showAddError('');
      closeDialog($('mcpAddDialog'));
      if (r.error) {
        toast(`Сервис сохранён, но не подключился: ${r.error}`, 'error');
        openConnectError(name, r.error);
      } else {
        // Итог проверяем по фактическому состоянию: «подключён» — только когда соединение есть.
        const fresh = findServer(r.servers, name);
        if (!fresh || groupOf(fresh) === 'connected') {
          toast('Сервис подключён. Его действия спрашиваются, пока вы не разрешите их в настройках', 'ok');
        } else if (groupOf(fresh) === 'error') {
          toast(`Сервис сохранён, но не подключился: ${explainError(fresh.error)}`, 'error');
        } else {
          toast('Сервис сохранён. Соединения ещё нет, действия появятся после подключения', 'ok');
        }
      }
    } finally {
      if (button) button.disabled = false;
    }
  });

  // ── Панель популярных ─────────────────────────────────────────
  let verifiedCatalog = null;

  function popularItems() {
    if (verifiedCatalog === null) return [];
    return verifiedCatalog.map((entry) => ({
      id: entry.id, title: entry.title, hint: entry.description,
      available: entry.ready === true,
      mail: entry.integration === 'mail',
      target: entry.url,
      reason: entry.accountKey ? `Укажите ${entry.accountKey} в настройке сборки.` : 'Требуется настройка доступа.',
      guide: entry.ready ? null : entry.docs || null, category: entry.category,
    }));
  }

  function popularMatches(item) {
    if (STATE.popularCat !== 'all' && (['git', 'dev'].includes(item.category) ? 'dev' : 'other') !== STATE.popularCat) return false;
    const q = STATE.q.trim().toLowerCase();
    if (!q) return true;
    return [item.id, item.title, item.hint, item.reason || ''].join(' ').toLowerCase().includes(q);
  }

  function installedNames() {
    return new Set(SERVERS.map((server) => String(server.name || '')));
  }

  function renderPopular() {
    const listBox = $('mcpPopularList');
    const catsBox = $('mcpPopularCats');
    if (!listBox || !catsBox) return;
    const items = popularItems().filter(popularMatches);
    const names = installedNames();
    const key = JSON.stringify(items.map((item) => [item.id, item.available])) + '|' + STATE.popularCat + '|' + STATE.q + '|' + [...names].join(',') + '|' + JSON.stringify(mail) + '|' + mailConnecting
      + '|' + SERVERS.map((server) => `${server.name}:${statusOf(server)}`).join(',');
    if (key === popularKey) return;
    popularKey = key;

    catsBox.replaceChildren(...POPULAR_CATS.map((cat) => el('button', {
      class: 'nox-chip-filter', type: 'button', 'data-popcat': cat.id,
      'aria-pressed': String(STATE.popularCat === cat.id),
      title: cat.full || cat.title,
      'aria-label': cat.full || cat.title,
      text: cat.title,
      onclick: () => { STATE.popularCat = cat.id; popularKey = ''; renderPopular(); },
    })));

    if (!items.length) {
      listBox.replaceChildren(el('p', { class: 'nox-popular-note', text: 'Ничего не нашлось — измените запрос.' }));
      return;
    }

    listBox.replaceChildren(...items.map((item) => {
      const already = names.has(item.id);
      let button;
      if (item.mail) {
        button = el('button', {
          class: 'mcp-popular-add', type: 'button',
          text: mail?.connected ? 'Подключён' : mailConnecting ? 'Вход в браузере…' : mail?.credentials ? 'Подключить' : 'Недоступно',
          disabled: mailConnecting || mail?.connected || !mail?.credentials,
          title: mail?.credentials ? 'Войти в Google' : 'Для входа нужно настроить Gmail в сборке Nox',
          onclick: () => connectPopularMail(),
        });
      } else if (item.guide && !already) {
        button = el('button', {
          class: 'mcp-popular-add', type: 'button', text: 'Настроить ↗',
          title: `Открыть инструкцию ${item.title}`,
          disabled: !bridge()?.openSource,
          onclick: async () => {
            try {
              const result = await bridge().openSource(item.guide);
              if (!result?.ok) toast('Не удалось открыть инструкцию', 'error');
            } catch { toast('Не удалось открыть инструкцию', 'error'); }
          },
        });
      } else if (item.available && !already) {
        button = el('button', {
          class: 'mcp-popular-add', type: 'button', text: '+ Добавить',
          title: `Добавить сервис «${item.title}»`,
          onclick: (e) => addPopular(item, e.currentTarget),
        });
      } else if (already) {
        button = el('button', { class: 'mcp-popular-add', type: 'button', disabled: true, text: 'Добавлен' });
        button.title = 'Сервис уже есть в списке подключений';
      } else {
        button = el('button', { class: 'mcp-popular-add', type: 'button', disabled: true, text: 'Не настроено' });
        button.title = item.reason || 'Сервис пока недоступен';
      }
      // Запись каталога без сохранённого сервиса — «Предложено», а не «подключено».
      const fresh = findServer(SERVERS, item.id);
      const row = el('div', {
        class: 'mcp-popular-row', 'data-popular': item.id,
        'data-group': fresh ? groupOf(fresh) : 'proposed',
      },
        popularIcon(item.id),
        el('div', { class: 'mcp-popular-main' },
          el('span', { class: 'mcp-popular-head' },
            el('span', { class: 'mcp-popular-name', text: item.title }),
            fresh ? statusPill(fresh) : pillOf('Предложено', 'ghost')),
          el('span', { class: 'mcp-popular-desc', text: String(item.hint || (fresh && fresh.target) || '') }),
          !already && item.reason ? el('span', { class: 'sr-only', text: item.reason }) : null),
        button);
      return row;
    }));
    fillIcons(listBox);
  }

  async function loadPopularMail(api) {
    if (typeof api?.mailState !== 'function' || typeof api.mailConnect !== 'function') return;
    try {
      const state = await api.mailState();
      mail = { credentials: Boolean(state?.credentials), connected: Boolean(state?.connected) };
    } catch { mail = null; }
    renderPopular();
  }

  async function connectPopularMail() {
    const api = bridge();
    if (!api || !mail?.credentials || mail.connected || mailConnecting) return;
    mailConnecting = true;
    renderPopular();
    try {
      const result = await api.mailConnect(true);
      if (!result?.ok) throw new Error(result?.error || 'Вход не завершён');
      toast('Gmail подключён', 'ok');
    } catch (err) {
      toast('Не удалось подключить Gmail: ' + String(err.message || err), 'error');
    } finally {
      mailConnecting = false;
      await loadPopularMail(api);
    }
  }

  async function addPopular(item, button) {
    const api = bridge();
    if (!api || !item || !item.available) return;
    if (button) { button.disabled = true; button.classList.add('is-busy'); }
    let r;
    try {
      r = await api.mcpAdd(item.id, item.target, item.args);
    } catch (err) {
      if (button) { button.disabled = false; button.classList.remove('is-busy'); }
      toast('Не получилось добавить: ' + String((err && err.message) || err), 'error');
      return;
    }
    if (button) { button.disabled = false; button.classList.remove('is-busy'); }
    if (!r || !r.ok) { toast((r && r.error) || 'Не получилось добавить', 'error'); return; }
    if (r.servers) paint(r.servers, { force: true });
    if (r.error) {
      toast(`Сервис «${item.title}» сохранён, но не подключился: ${explainError(r.error)}`, 'error');
      openConnectError(item.id, r.error);
    } else {
      const fresh = findServer(r.servers, item.id);
      if (!fresh || groupOf(fresh) === 'connected') {
        toast(`Сервис «${item.title}» подключён. Его действия спрашиваются, пока вы не разрешите их`, 'ok');
      } else if (groupOf(fresh) === 'error') {
        toast(`Сервис «${item.title}» сохранён, но не подключился: ${explainError(fresh.error)}`, 'error');
        openConnectError(item.id, fresh.error);
      } else {
        toast(`Сервис «${item.title}» добавлен. Соединения ещё нет, действия появятся после подключения`, 'ok');
      }
    }
  }

  // ── Копирование адреса (без секретов: target уже публичный) ────
  function legacyCopy(value) {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function copyText(value) {
    const text = String(value || '');
    if (!text) return Promise.resolve(false);
    try {
      if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text));
      }
    } catch { /* нет доступа к буферу */ }
    return Promise.resolve(legacyCopy(text));
  }

  // ── Загрузка состояния и опрос ────────────────────────────────
  function paint(servers, options = {}) {
    SERVERS = Array.isArray(servers) ? servers : [];
    if (options.force) { listKey = ''; popularKey = ''; }
    renderCounts();
    renderList();
    renderPopular();
  }

  function showLoading() {
    const loading = $('mcpLoading');
    if (loading) loading.hidden = false;
    if (empty) empty.hidden = true;
    const noResults = $('mcpNoResults');
    if (noResults) noResults.hidden = true;
  }

  let loadedOnce = false;

  async function load() {
    const api = bridge();
    if (!api) return;
    if (!loadedOnce) showLoading();
    try {
      const state = await api.mcpState();
      LOAD_ERROR = '';
      verifiedCatalog = Array.isArray(state?.catalog) ? state.catalog : null;
      paint((state && state.servers) || []);
      if (!mailConnecting) void loadPopularMail(api);
    } catch (err) {
      LOAD_ERROR = 'Не удалось прочитать подключения: ' + String((err && err.message) || err);
      renderLoadError();
    } finally {
      loadedOnce = true;
    }
  }

  // Непрерывная проверка состояния: сервер мог упасть или подключиться сам. Опрос идёт
  // только когда раздел «Подключения» виден на экране.
  let timer = null;
  function polling(on) {
    if (on && !timer) timer = setInterval(() => { if (view && !view.hidden) load(); }, POLL_MS);
    if (!on && timer) { clearInterval(timer); timer = null; }
  }

  // ── Связывание элементов ──────────────────────────────────────
  function initControls() {
    const search = $('mcpSearch');
    if (search) {
      search.addEventListener('input', () => {
        STATE.q = String(search.value || '');
        listKey = '';
        popularKey = '';
        renderList();
        renderPopular();
      });
    }
    const filters = $('mcpFilters');
    if (filters) {
      filters.addEventListener('click', (e) => {
        const chip = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-filter]') : null;
        if (!chip) return;
        STATE.filter = chip.getAttribute('data-filter') || 'all';
        listKey = '';
        renderList();
        renderCounts();
      });
    }
    const reset = $('mcpResetFilters');
    if (reset) {
      reset.addEventListener('click', () => {
        STATE.q = '';
        STATE.filter = 'all';
        const searchNode = $('mcpSearch');
        if (searchNode) searchNode.value = '';
        listKey = '';
        popularKey = '';
        renderList();
        renderPopular();
        renderCounts();
      });
    }
    const reload = $('mcpReload');
    if (reload) reload.addEventListener('click', () => { listKey = ''; load(); });
    const retryLoad = $('mcpErrorRetry');
    if (retryLoad) retryLoad.addEventListener('click', () => { listKey = ''; load(); });

    const addBtn = $('mcpAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => openAdd(addBtn));
    const emptyAdd = $('mcpEmptyAdd');
    if (emptyAdd) emptyAdd.addEventListener('click', () => openAdd(emptyAdd));

    // Диалог добавления.
    const closeAdd = () => closeDialog($('mcpAddDialog'));
    for (const id of ['mcpAddClose', 'mcpAddCancel']) {
      const node = $(id);
      if (node) node.addEventListener('click', closeAdd);
    }
    for (const id of ['mcpName', 'mcpTarget', 'mcpArgs']) {
      const node = $(id);
      if (node) node.addEventListener('input', updateAddValidity);
    }
    const addDialog = $('mcpAddDialog');
    if (addDialog) addDialog.addEventListener('cancel', () => { closeDialog(addDialog); });
    if (addDialog) addDialog.addEventListener('close', () => { if (lastTrigger && typeof lastTrigger.focus === 'function') { try { lastTrigger.focus(); } catch { /* пусто */ } } });

    // Детали.
    for (const id of ['mcpDetailsX', 'mcpDetailsClose']) {
      const node = $(id);
      if (node) node.addEventListener('click', () => closeDialog($('mcpDetailsDialog')));
    }
    const detailsDialog = $('mcpDetailsDialog');
    if (detailsDialog) detailsDialog.addEventListener('cancel', () => closeDialog(detailsDialog));
    const detailsDelete = $('mcpDetailsDelete');
    if (detailsDelete) detailsDelete.addEventListener('click', () => {
      const server = SERVERS.find((x) => x.name === detailName);
      if (server) openDelete(server);
    });

    // Удаление.
    const deleteDialog = $('mcpDeleteDialog');
    for (const id of ['mcpDeleteClose', 'mcpDeleteCancel']) {
      const node = $(id);
      if (node) node.addEventListener('click', () => closeDialog(deleteDialog));
    }
    if (deleteDialog) deleteDialog.addEventListener('cancel', () => closeDialog(deleteDialog));
    const deleteInput = $('mcpDeleteInput');
    if (deleteInput) {
      deleteInput.addEventListener('input', () => {
        const confirm = $('mcpDeleteConfirm');
        if (confirm) confirm.disabled = String(deleteInput.value || '').trim() !== deleteName;
      });
    }
    const deleteConfirm = $('mcpDeleteConfirm');
    if (deleteConfirm) deleteConfirm.addEventListener('click', confirmDelete);

    // Изменения набора действий.
    const driftDialog = $('mcpDriftDialog');
    for (const id of ['mcpDriftClose', 'mcpDriftCancel']) {
      const node = $(id);
      if (node) node.addEventListener('click', () => closeDialog(driftDialog));
    }
    if (driftDialog) driftDialog.addEventListener('cancel', () => closeDialog(driftDialog));
    const driftConfirm = $('mcpDriftConfirm');
    if (driftConfirm) driftConfirm.addEventListener('click', confirmDrift);

    // Ошибка подключения.
    const errorDialog = $('mcpErrorDialog');
    for (const id of ['mcpConnErrX', 'mcpConnErrClose']) {
      const node = $(id);
      if (node) node.addEventListener('click', () => closeDialog(errorDialog));
    }
    if (errorDialog) errorDialog.addEventListener('cancel', () => closeDialog(errorDialog));
    const errorRetry = $('mcpConnErrRetry');
    if (errorRetry) {
      errorRetry.addEventListener('click', async () => {
        const name = errorDialog ? String(errorDialog.dataset.name || '') : '';
        const api = bridge();
        if (!name || !api) return;
        errorRetry.disabled = true;
        let r;
        try { r = await api.mcpToggle(name, false); }
        catch (err) { errorRetry.disabled = false; openConnectError(name, String((err && err.message) || err)); return; }
        errorRetry.disabled = false;
        if (r && r.servers) paint(r.servers, { force: true });
        if (!r || !r.ok) { openConnectError(name, (r && r.error) || 'не получилось переподключить'); return; }
        if (r.error) { openConnectError(name, String(r.error)); return; }
        closeDialog(errorDialog);
        toast(`Сервис «${name}» подключён`, 'ok');
      });
    }

    // Подсказка о добавлении: новая сборка подключает сервис сразу, пакет ставится только по действию владельца.
    if (note) {
      note.textContent = 'Сервис подключается сразу, перезапуск не нужен. Если это команда npx или uvx, пакет сервера может скачаться при первом запуске — сервис ставится только по вашему действию. Действия сервиса всегда спрашиваются, пока вы не разрешите их в настройках.';
    }
  }

  // Мост окна может появиться позже страницы (в браузерной проверке его ставит dev-stub).
  document.addEventListener('jarvis:view', (e) => {
    const active = e.detail === 'mcp';
    polling(active);
    if (active) { listKey = ''; load(); }
  });

  initControls();
  showLoading();
  load();
})();
