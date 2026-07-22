// Self-contained Shiki→Monaco bundle for the native file:// editor. Mirrors
// riven's editor/highlight.ts, but exposes a global init so editor.html can call
// it after Monaco's AMD boot. esbuild inlines the oniguruma wasm (no CDN, no
// dynamic fetch) so it works on a file:// origin.
import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { shikiToMonaco } from '@shikijs/monaco'
import getWasm from 'shiki/wasm'

import ts from '@shikijs/langs/typescript'
import js from '@shikijs/langs/javascript'
import tsx from '@shikijs/langs/tsx'
import jsx from '@shikijs/langs/jsx'
import json from '@shikijs/langs/json'
import css from '@shikijs/langs/css'
import scss from '@shikijs/langs/scss'
import less from '@shikijs/langs/less'
import html from '@shikijs/langs/html'
import markdown from '@shikijs/langs/markdown'
import python from '@shikijs/langs/python'
import rust from '@shikijs/langs/rust'
import go from '@shikijs/langs/go'
import yaml from '@shikijs/langs/yaml'
import sql from '@shikijs/langs/sql'
import toml from '@shikijs/langs/toml'
import java from '@shikijs/langs/java'
import cpp from '@shikijs/langs/cpp'
import csharp from '@shikijs/langs/csharp'
import ruby from '@shikijs/langs/ruby'
import php from '@shikijs/langs/php'
import swift from '@shikijs/langs/swift'
import kotlin from '@shikijs/langs/kotlin'
import shell from '@shikijs/langs/shellscript'
import ini from '@shikijs/langs/ini'
import xml from '@shikijs/langs/xml'
import vue from '@shikijs/langs/vue'
import svelte from '@shikijs/langs/svelte'
import graphql from '@shikijs/langs/graphql'
import docker from '@shikijs/langs/docker'
import make from '@shikijs/langs/make'

import vesper from '@shikijs/themes/vesper'
import nightOwl from '@shikijs/themes/night-owl'
import kanagawa from '@shikijs/themes/kanagawa-wave'
import houston from '@shikijs/themes/houston'
import darkPlus from '@shikijs/themes/dark-plus'
import githubLight from '@shikijs/themes/github-light'
import solarizedLight from '@shikijs/themes/solarized-light'

const TS_CONFIG = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [
    { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
    { open: '"', close: '"' }, { open: "'", close: "'" }, { open: '`', close: '`' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
    { open: '"', close: '"' }, { open: "'", close: "'" }, { open: '`', close: '`' }, { open: '<', close: '>' }
  ]
}

window.rivenInitShiki = async function (monaco) {
  function reg(id, exts) {
    if (!monaco.languages.getLanguages().some((l) => l.id === id)) {
      monaco.languages.register({ id, extensions: exts })
      monaco.languages.setLanguageConfiguration(id, TS_CONFIG)
    }
  }
  reg('tsx', ['.tsx']); reg('jsx', ['.jsx']); reg('toml', ['.toml'])
  reg('vue', ['.vue']); reg('svelte', ['.svelte']); reg('make', [])
  const highlighter = await createHighlighterCore({
    engine: createOnigurumaEngine(getWasm),
    themes: [vesper, nightOwl, kanagawa, houston, darkPlus, githubLight, solarizedLight],
    langs: [ts, js, tsx, jsx, json, css, scss, less, html, markdown, python, rust, go, yaml,
            sql, toml, java, cpp, csharp, ruby, php, swift, kotlin, shell, ini, xml, vue,
            svelte, graphql, docker, make]
  })
  shikiToMonaco(highlighter, monaco)
  return true
}
