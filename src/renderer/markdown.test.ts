import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Markdown } from './Markdown';

const render = (content: string) => renderToStaticMarkup(createElement(Markdown, { content }));

it('renders rich text, nested lists, tables, underline and highlighted code', () => {
  const html = render('# Heading\n\n**Bold** *italic* <u>underline</u> ~~removed~~\n\n> Quote\n\n- First\n  - Nested\n\n| Name | Value |\n| --- | --- |\n| Mercury | Local |\n\n```js\nconst greeting = "hello";\n```');
  for (const expected of ['<h1>Heading</h1>', '<strong>Bold</strong>', '<em>italic</em>', '<u>underline</u>', '<del>removed</del>', '<blockquote>', '<table>', 'hljs-keyword', 'Copy code']) expect(html).toContain(expected);
});

it('removes executable HTML and unsafe links without loading external images', () => {
  const html = render('<script>alert(1)</script><iframe src="https://example.com"></iframe>\n\n<u onclick="alert(1)" style="color:red">safe underline</u>\n\n[unsafe](javascript:alert%281%29) ![alt](https://example.com/tracker.png)');
  expect(html).toContain('<u>safe underline</u>');
  for (const unsafe of ['<script', '<iframe', 'onclick', 'style=', 'javascript:', '<img', 'tracker.png']) expect(html).not.toContain(unsafe);
});

it('renders math and preserves unfinished streaming Markdown safely', () => {
  expect(render('Euler: $e^{i\\pi}+1=0$')).toContain('class="katex"');
  expect(render('```python\nprint("streaming')).toContain('code-block');
  expect(render('**not finished')).toContain('**not finished');
});
