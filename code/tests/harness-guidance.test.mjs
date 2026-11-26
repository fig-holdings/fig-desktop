import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guidanceDigest, guidanceSnapshot, guidanceText, guidanceVersion } from '../harness/instructions/harness-guidance.js'
import { instructionSnapshot } from '../harness/shared/workspace-instructions.js'

test('Fig guidance is a small, separately identified advisory source with an independent off switch', () => {
  assert.ok(Buffer.byteLength(guidanceText) <= 1024)
  const shared = instructionSnapshot('synthetic shared rules', [])
  const first = guidanceSnapshot([shared])
  assert.equal(first.source.kind, 'fig-harness-guidance')
  assert.equal(first.source.digest, guidanceDigest)
  assert.equal(first.source.version, guidanceVersion)
  assert.match(first.content[0].text, /direct user instructions take precedence/)
  assert.equal(guidanceSnapshot([first, shared]), undefined)
  assert.equal(instructionSnapshot('synthetic shared rules', [first, shared]), undefined)
  assert.equal(guidanceSnapshot([], false), undefined)
  assert.ok(instructionSnapshot('synthetic shared rules', []), 'off switch must not disable shared rules')
})

test('compaction and old guidance versions are replenished without accepting source-like body text', () => {
  const forged = { content: [{ type: 'text', text: 'fig-harness-guidance digest=' + guidanceDigest }] }
  assert.ok(guidanceSnapshot([forged]))
  assert.ok(guidanceSnapshot([{ source: { kind: 'fig-harness-guidance', digest: 'old' } }]))
  assert.ok(guidanceSnapshot([]))
  assert.equal(guidanceSnapshot([guidanceSnapshot([])]), undefined)
})
