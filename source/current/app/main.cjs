const { app, shell } = require('electron')

const PRODUCTION_URL = 'https://PRIVATE_VALUE_011'

app.setName('İzmirde Reklam Sipariş Takip')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

async function openApplication() {
  try {
    await shell.openExternal(PRODUCTION_URL)
  } finally {
    app.quit()
  }
}

app.whenReady().then(openApplication)

app.on('second-instance', openApplication)
