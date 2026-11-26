import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
const source=await readFile(new URL('../harness/desktop-brand/client.js',import.meta.url),'utf8')
function setup(random){
 let module,component,words,refs=[],cursor=0
 const context={__FIG_BRAND_ICON__:'light',__FIG_BRAND_ICON_DARK__:'dark',Math:{random},window:{__ModuleLoader__:{load(spec){module=spec.factory(()=>({createElement:(tag,props)=>({tag,props}),useLayoutEffect:()=>{},useRef:value=>refs[cursor++]??(refs[cursor-1]={current:value})}))}}}}
 vm.runInNewContext(source,context)
 const ctx={effect:fn=>fn(),locale:{register:(_id,dict)=>{words=dict},bind:()=>()=>''},slots:{inject:(_name,fn)=>fn(),register:(spec,fn)=>{if(spec.name==='conversation.hero.brand.mark')component=fn}},theme:{},on:()=>{}}
 module.apply(ctx)
 return {words,render(){cursor=0;component({size:34,className:'',useTheme:()=> 'light'});return refs[1].current}}
}
test('welcome selects each whole pair and does not reroll on render',()=>{
 for(const [sample,expected] of [[0,0],[0.499,0],[0.5,1],[0.999,1]]){
  let draws=0;const instance=setup(()=>{draws++;return sample})
  assert.equal(instance.render(),expected);assert.equal(instance.render(),expected);assert.equal(draws,1)
  assert.equal(instance.words.zh.welcomeHeadline0,'今天，从哪件事开始？')
  assert.equal(instance.words.en.welcomeSubtitle0,'Pick up a project, or start something new.')
  assert.equal(instance.words.zh.welcomeSubtitle1,'从一个问题、一份材料或一个项目开始。')
  assert.equal(instance.words.en.welcomeHeadline1,'Have an idea? Let’s try it out.')
 }
})
