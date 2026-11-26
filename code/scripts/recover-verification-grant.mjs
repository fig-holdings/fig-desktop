// Returns the ChatGPT grant to the daily credential file after a verification run that held it exclusively
// (refresh-handoff.mjs) stopped before handing it back, e.g. it crashed or was killed. Run it by hand only when that
// run's journal (<credentials file>.fig-verification-handoff.json) is still there:
//
//   node scripts/recover-verification-grant.mjs --source=<absolute credentials file> --dsh-modules=<installed DSH node_modules>
//
// Exit 0: the latest grant is back and the recovery copy can be removed. Exit 2: arguments missing. Exit 3: nothing was
// returned; keep the journal and the isolated copy.
import { recoverRefreshHandoff } from './refresh-handoff.mjs'

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const source = option('source')
const modules = option('dsh-modules')
if (!source || !modules) {
  console.error('Require --source=absolute-credentials-file and --dsh-modules=installed-fixed-modules')
  process.exit(2)
}
try {
  const recovery = await recoverRefreshHandoff({ source, modules })
  console.log(recovery.returned ? 'Latest credential ownership returned; recovery copy can now be removed.' : 'Return unconfirmed')
  process.exitCode = recovery.returned ? 0 : 3
} catch {
  console.error('Credential recovery blocked. Keep the journal and isolated copy; no older grant was restored.')
  process.exitCode = 3
}
