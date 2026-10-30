import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSnapshot,
  renderDocument,
  renderTabText,
  resolveTab,
  tabSummary,
  truncateText,
} from '../lib/core/document.js'
import { parseGoogleRef, googleDocUrl, toSnapshot } from '../lib/adapters/google/convert.js'

const DOCUMENT_FIXTURE = {
  documentId: 'doc-fixture',
  title: 'Fixture',
  revisionId: 'rev-7',
  tabs: [
    {
      tabProperties: { tabId: 't.0', title: 'Main', index: 0 },
      documentTab: {
        body: {
          content: [
            {
              startIndex: 0,
              endIndex: 1,
              paragraph: { elements: [{ textRun: { content: '\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } },
            },
            {
              startIndex: 1,
              endIndex: 12,
              paragraph: {
                elements: [{ textRun: { content: 'Overview\n', textStyle: { bold: true } } }],
                paragraphStyle: { namedStyleType: 'HEADING_1' },
              },
            },
            {
              startIndex: 12,
              endIndex: 22,
              paragraph: {
                elements: [{ textRun: { content: 'first item\n' } }],
                paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
                bullet: { listId: 'list-1', nestingLevel: 0 },
              },
            },
            {
              startIndex: 22,
              endIndex: 60,
              table: {
                tableRows: [
                  {
                    tableCells: [
                      { content: [{ paragraph: { elements: [{ textRun: { content: 'A\n' } }] } }] },
                      { content: [{ paragraph: { elements: [{ textRun: { content: 'B|pipe\n' } }] } }] },
                    ],
                  },
                  {
                    tableCells: [
                      { content: [{ paragraph: { elements: [{ textRun: { content: 'C\n' } }] } }] },
                      { content: [{ paragraph: { elements: [{ textRun: { content: 'D\n' } }] } }] },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      childTabs: [
        {
          tabProperties: { tabId: 't.1', title: 'Child', index: 1 },
          documentTab: {
            body: {
              content: [
                {
                  startIndex: 0,
                  endIndex: 8,
                  paragraph: {
                    elements: [{ textRun: { content: 'child\n', textStyle: { link: { url: 'https://example.com' } } } }],
                    paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
                  },
                },
              ],
            },
          },
          childTabs: [],
        },
      ],
    },
  ],
}

test('Google conversion produces portable blocks and native indexes', () => {
  const snapshot = toSnapshot(DOCUMENT_FIXTURE)
  assert.equal(snapshot.platform, 'google-docs')
  assert.equal(snapshot.documentId, 'doc-fixture')
  assert.equal(snapshot.revision, 'rev-7')
  assert.equal(snapshot.tabs.length, 2)
  assert.equal(snapshot.tabs[0].id, 't.0')
  assert.equal(snapshot.tabs[0].startIndex, 0)
  assert.equal(snapshot.tabs[0].endIndex, 60)
  assert.equal(snapshot.tabs[1].depth, 1)
  assert.equal(snapshot.tabs[1].id, 't.1')

  const [blank, heading, list, table] = snapshot.tabs[0].blocks
  assert.equal(blank.type, 'paragraph')
  assert.equal(heading.type, 'heading')
  assert.equal(heading.level, 1)
  assert.equal(heading.text, '**Overview**')
  assert.equal(list.type, 'list')
  assert.equal(list.level, 0)
  assert.equal(table.type, 'table')
  assert.deepEqual(table.rows, [['A', 'B|pipe'], ['C', 'D']])
  assert.match(snapshot.tabs[1].blocks[0].text, /\[child\]\(https:\/\/example\.com\)/)
})

test('renderDocument emits markdown, tab headers, and a text dialect', () => {
  const snapshot = normalizeSnapshot(toSnapshot(DOCUMENT_FIXTURE))
  const markdown = renderDocument(snapshot)
  assert.match(markdown.text, /## Tab: Main `t\.0`/)
  assert.match(markdown.text, /# \*\*Overview\*\*/)
  assert.match(markdown.text, /- first item/)
  assert.match(markdown.text, /\| A \| B\\\|pipe \|/)
  assert.match(markdown.text, /## Tab: Child `t\.1`/)
  assert.equal(markdown.truncated, false)

  const plain = renderDocument(snapshot, { format: 'text' })
  assert.doesNotMatch(plain.text, /^## Tab/m)
  assert.match(plain.text, /=== Tab: Main \[t\.0\] ===/)
  assert.doesNotMatch(plain.text, /^# /m)
})

test('resolveTab accepts id, unique title, and order', () => {
  const snapshot = normalizeSnapshot(toSnapshot(DOCUMENT_FIXTURE))
  assert.equal(resolveTab(snapshot).id, 't.0')
  assert.equal(resolveTab(snapshot, 't.1').id, 't.1')
  assert.equal(resolveTab(snapshot, 'Child').id, 't.1')
  assert.equal(resolveTab(snapshot, 1).id, 't.1')
  assert.throws(() => resolveTab(snapshot, 'missing'), /no tab matches/)
})

test('truncateText marks the bound and keeps the prefix', () => {
  const result = truncateText('abcdefghij', 4)
  assert.equal(result.truncated, true)
  assert.match(result.text, /^abcd\n\n\[truncated after 4 of 10 characters/)
  assert.equal(truncateText('abc', 10).truncated, false)
})

test('parseGoogleRef accepts document URLs, open?id URLs, and raw ids', () => {
  assert.deepEqual(parseGoogleRef('https://docs.google.com/document/d/abcDEF123456/edit'), {
    documentId: 'abcDEF123456',
    url: googleDocUrl('abcDEF123456'),
  })
  assert.equal(parseGoogleRef('https://docs.google.com/document/u/0/d/abcDEF123456/edit?tab=t.0').documentId, 'abcDEF123456')
  assert.equal(parseGoogleRef('https://docs.google.com/document/d/abcDEF123456').documentId, 'abcDEF123456')
  assert.equal(parseGoogleRef('docs.google.com/document/d/abcDEF123456/edit').documentId, 'abcDEF123456')
  assert.equal(parseGoogleRef('https://docs.google.com/document/open?id=abcDEF123456').documentId, 'abcDEF123456')
  assert.equal(parseGoogleRef('abcDEF123456').documentId, 'abcDEF123456')
  assert.equal(parseGoogleRef('https://example.com/document/d/abc'), null)
  assert.equal(parseGoogleRef('two words'), null)
  assert.equal(parseGoogleRef('short'), null)
})

test('tabSummary reports counts and ranges without the body', () => {
  const snapshot = normalizeSnapshot(toSnapshot(DOCUMENT_FIXTURE))
  const summary = tabSummary(snapshot.tabs[0])
  assert.equal(summary.id, 't.0')
  assert.equal(summary.title, 'Main')
  assert.equal(summary.index, 0)
  assert.equal(summary.depth, 0)
  assert.equal(typeof summary.chars, 'number')
  assert.equal(summary.startIndex, 0)
  assert.equal(summary.endIndex, 60)
  assert.equal('text' in summary, false)
})

test('renderTabText prefers adapter-provided text over blocks', () => {
  assert.equal(renderTabText({ id: 'x', title: 'X', text: 'already rendered' }), 'already rendered')
})
