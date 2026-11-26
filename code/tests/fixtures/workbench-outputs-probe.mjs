import {pageRoute,registerPageRoute} from '../../harness/shared/http.js'
export function apply(ctx) {
 registerPageRoute(ctx,'/outputs-probe','outputs test probe',pageRoute({prefix:'/outputs-probe',endpoints:{
  declare({id,files}) {const agent=ctx.get('agents').get(id);agent.session.append('deliverables/presented',{turn:1,callId:'synthetic-output',files});return true}
 }}))
}
