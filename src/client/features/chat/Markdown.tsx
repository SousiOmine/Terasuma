import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";
import { t } from "../../i18n";
import { type MarkdownBlock, type MarkdownInline, type MarkdownListItem, parseMarkdown } from "./markdown-parse";

/**
 * 発言の本文を Markdown として描く。
 *
 * 解釈した木をそのまま要素へ写す。HTML の文字列や innerHTML は使わない。
 * 本文に HTML が混ざっていても、タグとして実行されず文字として出る。
 * 閉じていない記法は、そのままの文字になる（入力の途中でも画面を壊さない）。
 *
 * 解釈は本文が変わったときだけ行う。画面の状態が変わるたびに、
 * 過去の発言をすべて読み直さないようにするため。
 */
export function Markdown({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  return <div class="tera-md">{blocks.map(renderBlock)}</div>;
}

const HEADING_TAGS = { 1: "h1", 2: "h2", 3: "h3", 4: "h4", 5: "h5", 6: "h6" } as const;

function renderBlock(block: MarkdownBlock, key: number): ComponentChildren {
  switch (block.type) {
    case "paragraph":
      return <p key={key}>{renderInline(block.children)}</p>;

    case "heading": {
      const Tag = HEADING_TAGS[block.level];
      return <Tag key={key}>{renderInline(block.children)}</Tag>;
    }

    case "code":
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      );

    case "list": {
      const items = block.items.map(renderListItem);
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }

    case "quote":
      return <blockquote key={key}>{block.children.map(renderBlock)}</blockquote>;

    case "rule":
      return <hr key={key} />;

    case "table":
      return (
        <div key={key} class="tera-md-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} style={{ textAlign: block.align[index] ?? undefined }}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function renderListItem(item: MarkdownListItem, key: number): ComponentChildren {
  return (
    <li key={key} class={item.checked === null ? undefined : "tera-md-task"}>
      {/* 操作できない印なので、状態は本文の意味で伝える。 */}
      {item.checked !== null && (
        <input
          type="checkbox"
          checked={item.checked}
          disabled
          aria-label={t("chat.markdown.task")}
          class="tera-md-check"
        />
      )}
      {renderItemBlocks(item.blocks)}
    </li>
  );
}

/**
 * 項目の中身。最初の段落だけは要素で囲まずに置く。
 * チェックボックスと同じ行に本文を並べ、項目の中に余計な段を増やさないため。
 */
function renderItemBlocks(blocks: readonly MarkdownBlock[]): ComponentChildren {
  const children: ComponentChildren[] = [];

  for (let key = 0; key < blocks.length; key++) {
    const block = blocks[key]!;
    if (key === 0 && block.type === "paragraph") {
      children.push(<span key={key}>{renderInline(block.children)}</span>);
      continue;
    }
    children.push(renderBlock(block, key));
  }

  return children;
}

function renderInline(nodes: readonly MarkdownInline[]): ComponentChildren {
  const children: ComponentChildren[] = [];

  for (let key = 0; key < nodes.length; key++) {
    const node = nodes[key]!;

    switch (node.type) {
      case "text":
        children.push(node.text);
        break;

      case "break":
        children.push(<br key={key} />);
        break;

      case "code":
        children.push(<code key={key}>{node.text}</code>);
        break;

      case "strong":
        children.push(<strong key={key}>{renderInline(node.children)}</strong>);
        break;

      case "em":
        children.push(<em key={key}>{renderInline(node.children)}</em>);
        break;

      case "strike":
        children.push(<del key={key}>{renderInline(node.children)}</del>);
        break;

      case "link":
        children.push(
          <a key={key} href={node.href} target="_blank" rel="noreferrer">
            {renderInline(node.children)}
          </a>,
        );
        break;
    }
  }

  return children;
}
