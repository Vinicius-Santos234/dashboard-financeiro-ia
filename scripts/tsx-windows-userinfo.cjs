/* eslint-disable @typescript-eslint/no-require-imports */
// O sandbox do Windows pode fazer `os.userInfo()` falhar com ENOMEM. O tsx
// chama essa função apenas para nomear sua pasta temporária; um nome estável é
// suficiente e não muda a identidade usada pela aplicação ou pelo Firebase.
const os = require('node:os')

try {
  os.userInfo()
} catch {
  os.userInfo = () => ({
    uid: -1,
    gid: -1,
    username: 'dashboard-financeiro',
    homedir: process.cwd(),
    shell: null,
  })
}
