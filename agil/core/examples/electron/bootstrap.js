/* Загружает SDK с сервера AgilFrame и монтирует звонок в окно Electron. */
(async () => {
  const query = new URLSearchParams(location.search);
  const serverUrl = query.get('server') || 'http://localhost:8787';
  const tenant = query.get('tenant') || 'demo';
  const room = query.get('room') || 'electron-demo';
  const name = query.get('name') || 'Electron';
  let token = query.get('token') || '';

  const status = document.getElementById('status');
  const message = document.getElementById('message');
  const serverLabel = document.getElementById('server');
  if (serverLabel) serverLabel.textContent = serverUrl;

  function fail(text) {
    status.hidden = false;
    message.textContent = text;
  }

  try {
    // SDK: один файл, глобальный AGILCalls (ES-вариант: /sdk/agil-calls-sdk.js).
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${serverUrl}/sdk/agilframe.js`;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Не удалось загрузить SDK'));
      document.head.append(script);
    });
    if (!window.AgilFrame) throw new Error('AgilFrame не найден');

    if (!token) {
      const response = await fetch(`${serverUrl}/v1/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: tenant, name: room }),
      });
      if (!response.ok) throw new Error(`Сервер ответил ${response.status}`);
      const created = await response.json();
      token = created.token;
      const targetRoom = created.room?.id ?? room;
      const call = await window.AgilFrame.mount('#call', {
        serverUrl,
        room: targetRoom,
        token,
        tenantId: tenant,
        participantName: name,
        theme: { scheme: 'auto' },
      });
      status.hidden = true;
      window.__agilCall = call;
    } else {
      const call = await window.AgilFrame.mount('#call', {
        serverUrl,
        room,
        token,
        tenantId: tenant,
        participantName: name,
        theme: { scheme: 'auto' },
      });
      status.hidden = true;
      window.__agilCall = call;
    }
  } catch (error) {
    fail(`Ошибка: ${error.message}. Проверьте, что сервер запущен: ${serverUrl}`);
  }
})();
