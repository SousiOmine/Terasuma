import { describe, expect, test } from "bun:test";
import { interactiveBlock, parseUiMarkup, type UiView } from "../src/shared/ui-markup";

/**
 * UI マークアップの解釈。
 *
 * 画面（クライアント）と検証（chat_ui ツール）が同じ関数を使うので、
 * ここで文法の約束を 1 か所に固定する。
 */

function viewOf(markup: string): UiView {
  const result = parseUiMarkup(markup);
  if (!result.ok) throw new Error(`解釈できなかった: ${result.problem}`);
  return result.view;
}

function problemOf(markup: string): string {
  const result = parseUiMarkup(markup);
  if (result.ok) throw new Error("解釈できてしまった");
  return result.problem;
}

describe("UI マークアップの解釈", () => {
  test("カードのブロックを並べた順に読む", () => {
    const view = viewOf(`<Card title="リリース">
      <Text>確認してください。</Text>
      <List ordered><Item>テスト</Item><Item>公開</Item></List>
      <Table><Row><Cell>名前</Cell><Cell>値</Cell></Row><Row><Cell>a</Cell><Cell>1</Cell></Row></Table>
      <Flow>
        <Node id="start" shape="pill">開始</Node>
        <Node id="check" shape="diamond">成功?</Node>
        <Edge from="start" to="check" label="次へ" dashed />
      </Flow>
      <Choice multiple>
        <Option description="短い確認">スモーク</Option>
        <Option>全テスト</Option>
      </Choice>
    </Card>`);

    expect(view.title).toBe("リリース");
    expect(view.blocks).toEqual([
      { type: "text", text: "確認してください。" },
      { type: "list", ordered: true, items: ["テスト", "公開"] },
      {
        type: "table",
        rows: [
          ["名前", "値"],
          ["a", "1"],
        ],
      },
      {
        type: "flow",
        nodes: [
          { id: "start", label: "開始", shape: "pill" },
          { id: "check", label: "成功?", shape: "diamond" },
        ],
        edges: [{ from: "start", to: "check", label: "次へ", dashed: true }],
      },
      {
        type: "choice",
        multiple: true,
        options: [
          { label: "スモーク", description: "短い確認" },
          { label: "全テスト", description: null },
        ],
      },
    ]);
  });

  test("見出しと真偽属性・省略可能な属性は省ける", () => {
    const view = viewOf("<Card><List><Item>a</Item></List></Card>");

    expect(view.title).toBeNull();
    expect(view.blocks).toEqual([{ type: "list", ordered: false, items: ["a"] }]);
  });

  test("段落の共通のインデントと前後の空白を落とす", () => {
    const view = viewOf(`<Card><Text>
      1 行目
       2 行目
    </Text></Card>`);

    expect(view.blocks).toEqual([{ type: "text", text: "1 行目\n 2 行目" }]);
  });

  test("実体参照を文字に戻す", () => {
    const view = viewOf('<Card title="A &amp; B"><Text>a &lt; b &amp;&amp; c &quot;d&quot;</Text></Card>');

    expect(view.title).toBe("A & B");
    expect(view.blocks).toEqual([{ type: "text", text: 'a < b && c "d"' }]);
  });

  test("フォームの入力欄を読む", () => {
    const view = viewOf(`<Card><Form submit="送る">
      <Field label="名前" required placeholder="例: Tera" />
      <Field label="数" type="number" />
      <Field label="プラン" type="select"><Option>無料</Option><Option>Pro</Option></Field>
      <Field label="同意" type="checkbox" required />
    </Form></Card>`);

    expect(view.blocks).toEqual([
      {
        type: "form",
        submit: "送る",
        fields: [
          { label: "名前", type: "text", required: true, placeholder: "例: Tera", options: [] },
          { label: "数", type: "number", required: false, placeholder: null, options: [] },
          {
            label: "プラン",
            type: "select",
            required: false,
            placeholder: null,
            options: [
              { label: "無料", description: null },
              { label: "Pro", description: null },
            ],
          },
          { label: "同意", type: "checkbox", required: true, placeholder: null, options: [] },
        ],
      },
    ]);
  });

  test("押すと発言を送るブロックを取り出せる", () => {
    const view = viewOf("<Card><Text>a</Text><Choice><Option>a</Option><Option>b</Option></Choice></Card>");
    const block = interactiveBlock(view);

    expect(block?.type).toBe("choice");
    expect(interactiveBlock(viewOf("<Card><Text>a</Text></Card>"))).toBeNull();
  });

  test("同じ入力からは同じ結果になる", () => {
    const markup = "<Card><Text>a</Text><Choice><Option>a</Option><Option>b</Option></Choice></Card>";

    expect(parseUiMarkup(markup)).toEqual(parseUiMarkup(markup));
  });

  describe("受け付けない書き方", () => {
    test("空・ルートが Card でない・ブロックが無い", () => {
      expect(problemOf("")).toContain("empty");
      expect(problemOf("  \n ")).toContain("empty");
      expect(problemOf("<Text>a</Text>")).toContain("the root must be <Card>");
      expect(problemOf("<Card></Card>")).toContain("needs at least one block");
    });

    test("知らないタグ・属性", () => {
      expect(problemOf("<Card><div>a</div></Card>")).toContain("<div> is not allowed inside <Card>");
      expect(problemOf('<Card foo="1"><Text>a</Text></Card>')).toContain('does not take the attribute "foo"');
      expect(problemOf('<Card><List foo="1"><Item>a</Item></List></Card>')).toContain(
        'does not take the attribute "foo"',
      );
    });

    test("囲みの中に直接テキストは書けない", () => {
      expect(problemOf("<Card>hello</Card>")).toContain("text is not allowed directly inside <Card>");
    });

    test("値の無い真偽属性に値は書けない", () => {
      expect(problemOf('<Card><List ordered="yes"><Item>a</Item></List></Card>')).toContain("takes no value");
    });

    test("属性はダブルクォートで閉じる", () => {
      expect(problemOf("<Card title=x><Text>a</Text></Card>")).toContain("must use double quotes");
      expect(problemOf('<Card title="x><Text>a</Text></Card>')).toContain("is not closed");
    });

    test("実体参照は 5 つだけ", () => {
      expect(problemOf("<Card><Text>a &nbsp; b</Text></Card>")).toContain('unknown entity "&nbsp;"');
      expect(problemOf("<Card><Text>a & b</Text></Card>")).toContain('write "&" as &amp;');
    });

    test("文章の中の < は実体参照にする", () => {
      expect(problemOf("<Card><Text>a < b</Text></Card>")).toContain('write "<" in text as &lt;');
      // タグの形になっているものは、置けないタグとして理由を返す。
      expect(problemOf("<Card><Text>a</Text><b>x</b></Card>")).toContain("<b> is not allowed inside <Card>");
    });

    test("閉じ忘れ・閉じタグの取り違え", () => {
      expect(problemOf("<Card><Text>a</Card>")).toContain("expected </Text>");
      expect(problemOf("<Card><Text>a")).toContain("is not closed");
      expect(problemOf("<Card><Text>a</Text></Card>trailing")).toContain("unexpected text");
    });

    test("コメントは書けない", () => {
      expect(problemOf("<Card><!-- x --><Text>a</Text></Card>")).toContain("comments and declarations");
    });

    test("入れ子は 4 段まで", () => {
      expect(problemOf("<Card><Text><Text><Text><Text>x</Text></Text></Text></Text></Card>")).toContain(
        "nested deeper than 4 levels",
      );
    });

    test("カードに置ける操作は 1 つまで", () => {
      const problem = problemOf(
        "<Card><Choice><Option>a</Option><Option>b</Option></Choice><Choice><Option>a</Option><Option>b</Option></Choice></Card>",
      );
      expect(problem).toContain("at most one <Choice> or <Form>");
    });

    test("選択肢は 2 つ以上", () => {
      expect(problemOf("<Card><Choice><Option>a</Option></Choice></Card>")).toContain("needs at least two <Option>");
    });

    test("フォームの入力欄は 1 つ以上", () => {
      expect(problemOf("<Card><Form></Form></Card>")).toContain("needs at least one <Field>");
      expect(problemOf("<Card><Form><Field /></Form></Card>")).toContain('needs the attribute "label"');
    });

    test("select には選択肢が要る", () => {
      expect(problemOf('<Card><Form><Field label="a" type="select" /></Form></Card>')).toContain(
        "needs at least one <Option>",
      );
    });

    test("知らない入力欄の種類", () => {
      expect(problemOf('<Card><Form><Field label="a" type="date" /></Form></Card>')).toContain(
        'unknown field type "date"',
      );
    });

    test("図のノード id は重複できない", () => {
      const problem = problemOf('<Card><Flow><Node id="a">x</Node><Node id="a">y</Node></Flow></Card>');
      expect(problem).toContain('the node id "a" is used twice');
    });

    test("図の辺は実在するノードを指す", () => {
      const problem = problemOf('<Card><Flow><Node id="a">x</Node><Edge from="a" to="b" /></Flow></Card>');
      expect(problem).toContain('unknown node "b"');
    });

    test("図の辺は自分自身を指さない", () => {
      const problem = problemOf('<Card><Flow><Node id="a">x</Node><Edge from="a" to="a" /></Flow></Card>');
      expect(problem).toContain("two different nodes");
    });

    test("知らない図の形", () => {
      expect(problemOf('<Card><Flow><Node id="a" shape="star">x</Node></Flow></Card>')).toContain(
        'unknown shape "star"',
      );
    });

    test("図の辺に中身は書けない", () => {
      expect(problemOf('<Card><Flow><Node id="a">x</Node><Edge from="a" to="b">y</Edge></Flow></Card>')).toContain(
        "has no content",
      );
    });

    test("表の行は同じ列数にする", () => {
      const problem = problemOf(
        "<Card><Table><Row><Cell>a</Cell><Cell>b</Cell></Row><Row><Cell>c</Cell></Row></Table></Card>",
      );
      expect(problem).toContain("every row needs 2 cells");
    });

    test("マークアップ全体の長さに上限がある", () => {
      const problem = problemOf(`<Card><Text>${"a".repeat(20_000)}</Text></Card>`);
      expect(problem).toContain("the limit is 20000");
    });

    test("エラーには行と桁が付く", () => {
      const problem = problemOf("<Card>\n  <Text>a</Text>\n  <Nope />\n</Card>");
      expect(problem).toMatch(/^line 3, column 3:/);
    });
  });
});
