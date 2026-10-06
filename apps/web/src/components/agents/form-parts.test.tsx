import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigSchemaForm, SecretSchemaFields } from "./form-parts";

test("technical config fields opt out of autofill without changing configured values", () => {
	const html = renderToStaticMarkup(createElement(ConfigSchemaForm, {
		schema: { type: "object", properties: {
			command: { type: "string", title: "CLI 命令" },
			retries: { type: "integer" },
		} },
		value: { command: "/opt/tools/codex", retries: 2 },
		onChange: () => assert.fail("render must not change config"),
	}));
	const inputs = html.match(/<input\b[^>]*>/g) ?? [];
	assert.equal(inputs.length, 2);
	for (const input of inputs) assert.match(input, /autoComplete="off"/i);
	assert.match(inputs[0], /autoCapitalize="none"/i);
	assert.match(inputs[0], /autoCorrect="off"/i);
	assert.match(inputs[0], /spellCheck="false"/i);
	assert.match(inputs[0], /value="\/opt\/tools\/codex"/);
	assert.match(inputs[1], /value="2"/);
});

test("JSON fallback does not use browser autofill or spelling corrections", () => {
	const html = renderToStaticMarkup(createElement(ConfigSchemaForm, {
		schema: undefined, value: { command: "codex" }, onChange: () => {},
	}));
	assert.match(html, /<textarea[^>]*autoComplete="off"/i);
	assert.match(html, /<textarea[^>]*spellCheck="false"/i);
	assert.ok(html.includes("codex"));
});

test("secret schema remains masked and requests new secrets, not stored login passwords", () => {
	const html = renderToStaticMarkup(createElement(SecretSchemaFields, {
		schema: [{ key: "API_KEY", label: "API Key", required: true }],
		configuredKeys: ["API_KEY"], values: {}, onChange: () => {},
	}));
	assert.match(html, /<input[^>]*type="password"/);
	assert.match(html, /<input[^>]*autoComplete="new-password"/i);
	assert.match(html, /<input[^>]*spellCheck="false"/i);
	assert.match(html, /<input[^>]*value=""/);
	assert.ok(html.includes("已配置，输入新值覆盖"));
});
