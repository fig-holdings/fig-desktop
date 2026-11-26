import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {NotificationPool} from '../app/main/notification-pool'
test('native notification references are held, bounded and released on click/close/failure/quit',()=>{
 class Item extends EventEmitter {closed=false;show(){}close(){this.closed=true;this.emit('close')}}
 const pool=new NotificationPool(2),a=new Item(),b=new Item(),c=new Item();let clicks=0
 pool.show(a,()=>clicks++);pool.show(b,()=>clicks++);assert.equal(pool.size,2)
 pool.show(c,()=>clicks++);assert.ok(a.closed);assert.equal(pool.size,2)
 b.emit('click');assert.equal(clicks,1);assert.equal(pool.size,1)
 c.emit('failed');assert.equal(pool.size,0)
 pool.show(new Item(),()=>{});pool.dispose();assert.equal(pool.size,0)
})
