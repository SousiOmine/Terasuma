import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSkillFileStore } from "../src/server/agent/skill-files";
import { SKILLS_DIR_IN_CONTAINER } from "../src/server/computer/container";
import { withTempDir } from "./harness";

/**
 * スキルの置き場。
 *
 * 置き場所は Agent Skills のユーザー領域に合わせて、コンテナのホームの中の
 * .agents/skills にする。ここではホスト側のパスを直接読み書きして確かめる。
 */

const HOST_SKILLS_DIR = join("container", "home", ".agents", "skills");

function skillsDir(dataDir: string): string {
  return join(dataDir, HOST_SKILLS_DIR);
}

function writeSkill(dataDir: string, name: string, text: string): void {
  const dir = join(skillsDir(dataDir), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text, "utf8");
}

describe("スキルの置き場", () => {
  test("空の置き場は 0 件を返す", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const store = createSkillFileStore({ dataDir: dir });

      expect(store.scan()).toEqual({ skills: [], problems: [] });
    });
  });

  test("作成したスキルは標準の場所に SKILL.md として書かれる", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const store = createSkillFileStore({ dataDir: dir });

      const skill = store.create({
        name: "deploy-notes",
        description: "Deploy notes",
        content: "# Deploy\n\nRun make deploy.",
      });

      expect(skill.dir).toBe(`${SKILLS_DIR_IN_CONTAINER}/deploy-notes`);

      const path = join(skillsDir(dir), "deploy-notes", "SKILL.md");
      const text = readFileSync(path, "utf8");
      expect(text.startsWith("---\n")).toBe(true);
      expect(text).toContain("name: deploy-notes");
      expect(text).toContain("description: Deploy notes");
      expect(text).toContain("Run make deploy.");

      expect(store.scan()).toEqual({
        skills: [{ name: "deploy-notes", description: "Deploy notes", content: "# Deploy\n\nRun make deploy." }],
        problems: [],
      });
    });
  });

  test("読み込むと本文とディレクトリと同梱ファイルを返す", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const store = createSkillFileStore({ dataDir: dir });
      store.create({ name: "deploy-notes", description: "Deploy notes", content: "body" });

      const skillDir = join(skillsDir(dir), "deploy-notes");
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      mkdirSync(join(skillDir, "references"), { recursive: true });
      writeFileSync(join(skillDir, "scripts", "run.sh"), "#!/bin/sh\n", "utf8");
      writeFileSync(join(skillDir, "references", "REFERENCE.md"), "# Reference\n", "utf8");

      const loaded = store.get("deploy-notes");
      expect(loaded?.dir).toBe(`${SKILLS_DIR_IN_CONTAINER}/deploy-notes`);
      expect(loaded?.resources).toEqual(["references/REFERENCE.md", "scripts/run.sh"]);
      expect(loaded?.resourcesTruncated).toBe(false);
    });
  });

  test("更新は説明と本文を書き換え、任意の frontmatter を残す", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      writeSkill(
        dir,
        "deploy-notes",
        '---\nname: deploy-notes\ndescription: Old\nlicense: MIT\nmetadata:\n  version: "1"\n---\n\nOld body\n',
      );

      const store = createSkillFileStore({ dataDir: dir });
      const updated = store.update("deploy-notes", { description: "New description", content: "New body" });

      expect(updated.description).toBe("New description");
      expect(updated.content).toBe("New body");

      const text = readFileSync(join(skillsDir(dir), "deploy-notes", "SKILL.md"), "utf8");
      expect(text).toContain("license: MIT");
      expect(text).toContain("version:");
      expect(text).toContain("description: New description");
      expect(text).toContain("New body");
    });
  });

  test("削除はスキルのディレクトリごと消す", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const store = createSkillFileStore({ dataDir: dir });
      store.create({ name: "deploy-notes", description: "Deploy notes", content: "body" });

      const skillDir = join(skillsDir(dir), "deploy-notes");
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      writeFileSync(join(skillDir, "scripts", "run.sh"), "#!/bin/sh\n", "utf8");

      expect(store.delete("deploy-notes")).toBe(true);
      expect(existsSync(skillDir)).toBe(false);
      expect(store.get("deploy-notes")).toBeNull();
      expect(store.delete("deploy-notes")).toBe(false);
    });
  });

  test("壊れた YAML は読み飛ばして理由を返す", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      writeSkill(dir, "broken", "---\nname: [\n---\n\nbody\n");
      writeSkill(dir, "good", "---\nname: good\ndescription: Good skill\n---\n\nbody\n");

      const store = createSkillFileStore({ dataDir: dir });
      const scan = store.scan();

      expect(scan.skills.map((skill) => skill.name)).toEqual(["good"]);
      expect(scan.problems).toHaveLength(1);
      expect(scan.problems[0]?.name).toBe("broken");
      expect(scan.problems[0]?.reason).toContain("invalid YAML frontmatter");
      expect(store.get("broken")).toBeNull();
    });
  });

  test("説明の無いスキルは読み飛ばす", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      writeSkill(dir, "nodesc", "---\nname: nodesc\n---\n\nbody\n");

      const store = createSkillFileStore({ dataDir: dir });
      const scan = store.scan();

      expect(scan.skills).toEqual([]);
      expect(scan.problems[0]?.name).toBe("nodesc");
      expect(scan.problems[0]?.reason).toContain("description");
    });
  });

  test("frontmatter の名前が違ってもディレクトリ名で読む", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      writeSkill(dir, "actual", "---\nname: other\ndescription: Actual skill\n---\n\nbody\n");

      const store = createSkillFileStore({ dataDir: dir });
      expect(store.scan().skills).toEqual([{ name: "actual", description: "Actual skill", content: "body" }]);
      expect(store.get("actual")?.name).toBe("actual");
    });
  });

  test("説明の改行はカタログ用に 1 行へ畳む", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const store = createSkillFileStore({ dataDir: dir });
      store.create({
        name: "multiline",
        description: "Line one\nLine two",
        content: "body",
      });

      expect(store.scan().skills[0]?.description).toBe("Line one Line two");
    });
  });

  test("仕様に合わない名前では作れない", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const store = createSkillFileStore({ dataDir: dir });
      const base = { description: "description", content: "body" };

      for (const name of ["", "Foo", "-foo", "foo-", "foo--bar", "foo_bar", "foo/bar", "a".repeat(65)]) {
        expect(() => store.create({ ...base, name })).toThrow();
      }

      expect(() => store.create({ ...base, name: "ok-name-2" })).not.toThrow();
    });
  });

  test("説明と本文の長さを検証する", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const store = createSkillFileStore({ dataDir: dir });

      expect(() => store.create({ name: "too-long", description: "a".repeat(1025), content: "body" })).toThrow();
      expect(() => store.create({ name: "empty", description: "description", content: "   " })).toThrow();
      expect(() =>
        store.create({ name: "too-long-body", description: "description", content: "a".repeat(50_001) }),
      ).toThrow();
    });
  });

  test("既存のディレクトリがある名前では作れない", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      mkdirSync(join(skillsDir(dir), "deploy-notes"), { recursive: true });

      const store = createSkillFileStore({ dataDir: dir });
      expect(() => store.create({ name: "deploy-notes", description: "description", content: "body" })).toThrow(
        "already exists",
      );
    });
  });

  test("存在しないスキルは更新できない", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const store = createSkillFileStore({ dataDir: dir });
      expect(() => store.update("missing", { content: "body" })).toThrow('No skill named "missing"');
    });
  });

  test("置き場の外を指す名前は読めず、消せない", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const store = createSkillFileStore({ dataDir: dir });

      expect(store.get("../outside")).toBeNull();
      expect(store.get("foo/bar")).toBeNull();
      expect(store.delete("../outside")).toBe(false);
      expect(store.delete("foo/bar")).toBe(false);
    });
  });

  test("SKILL.md がシンボリックリンクなら読まない", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const skillDir = join(skillsDir(dir), "linked");
      mkdirSync(skillDir, { recursive: true });

      const outside = join(dir, "outside.md");
      writeFileSync(outside, "---\nname: linked\ndescription: Outside\n---\n\noutside\n", "utf8");
      symlinkSync(outside, join(skillDir, "SKILL.md"));

      const store = createSkillFileStore({ dataDir: dir });
      expect(store.get("linked")).toBeNull();

      const scan = store.scan();
      expect(scan.skills).toEqual([]);
      expect(scan.problems[0]?.reason).toContain("not a regular file");
    });
  });

  test("置き場がシンボリックリンクなら読まない", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      const outside = join(dir, "outside");
      mkdirSync(outside, { recursive: true });
      mkdirSync(join(dir, "container", "home"), { recursive: true });
      symlinkSync(outside, join(dir, "container", "home", ".agents"));

      const store = createSkillFileStore({ dataDir: dir });
      const scan = store.scan();
      expect(scan.skills).toEqual([]);
      expect(scan.problems[0]?.reason).toContain("not a regular directory");
      expect(store.get("deploy-notes")).toBeNull();
      expect(() => store.create({ name: "deploy-notes", description: "description", content: "body" })).toThrow(
        "Cannot create a skill",
      );
    });
  });

  test("SKILL.md の無いディレクトリは無視する", async () => {
    await withTempDir("terasuma-skills-", (dir) => {
      mkdirSync(join(skillsDir(dir), "not-a-skill"), { recursive: true });

      const store = createSkillFileStore({ dataDir: dir });
      expect(store.scan()).toEqual({ skills: [], problems: [] });
    });
  });
});
