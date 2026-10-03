import assert from "node:assert/strict";
import { createElement } from "react";
import { test } from "node:test";
import { hasMarkdownContent } from "./markdown-content.js";

test("空列表项不显示圆点，嵌套文本、零值和图片列表内容保留", () => {
  for (const empty of [undefined, null, false, " \n", [], createElement("p", null, " "), createElement("span", null, createElement("br"))]) {
    assert.equal(hasMarkdownContent(empty), false);
  }
  for (const content of ["正文", 0, createElement("p", null, createElement("strong", null, "正文")), createElement("img", { src: "assets/image.png", alt: "" })]) {
    assert.equal(hasMarkdownContent(content), true);
  }
});
