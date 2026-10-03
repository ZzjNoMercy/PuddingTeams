import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessagePreview } from "./message-preview";

const render = (content: string) => renderToStaticMarkup(createElement(MessagePreview, { content }));

test("摘要保留行内 Markdown，标题不产生块级布局", () => {
	const html = render("## 回执 **目标库**：人脉，`queued`，*待审核*，~~旧版~~");
	assert.match(html, /<strong>目标库<\/strong>/);
	assert.match(html, /<code>queued<\/code>/);
	assert.match(html, /<em>待审核<\/em>/);
	assert.match(html, /<del>旧版<\/del>/);
	assert.doesNotMatch(html, /##|\*\*|<(?:div|p|h[1-6])\b/);
});

test("链接与图片只显示文字，不引入嵌套交互或外部资源", () => {
	const html = render("[文档](https://example.com) ![封面](https://example.com/image.png) <img src=x onerror=alert(1)>");
	assert.match(html, /文档/);
	assert.match(html, /封面/);
	assert.doesNotMatch(html, /<(?:a|img|button|input|iframe)\b/);
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("列表、表格与代码块收为行内摘要，没有操作按钮", () => {
	for (const content of ["- 第一项\n- 第二项", "| 名称 | 状态 |\n| --- | --- |\n| Wiki | 完成 |", "```js\nconst done = true;\n```"] ) {
		const html = render(content);
		assert.doesNotMatch(html, /<(?:div|p|ul|ol|li|table|tr|td|pre|button)\b/);
	}
});

test("纯文本保留并限制异常超长摘要输入", () => {
	assert.match(render("今天完成工作 ✅"), /今天完成工作 ✅/);
	assert.equal(render("x".repeat(2000)).match(/x/g)?.length, 512);
});

test("被摘要折成一行的标题符号隐藏，但代码内的符号保留", () => {
	const html = render("已完成。 ## 结果：**完成**，`# code`，#topic");
	assert.doesNotMatch(html, /##/);
	assert.match(html, /<code># code<\/code>/);
	assert.match(html, /#topic/);
});
