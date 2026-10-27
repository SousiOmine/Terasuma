import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, posix } from "node:path";
import { describeError } from "../../shared/errors";
import { oneLine } from "../../shared/text";
import { formatSkillFile, readFrontmatter } from "./frontmatter";
import { listSkillResources } from "./skill-scan";
import { containerHomeDir, SKILLS_DIR_IN_CONTAINER } from "../computer/container";
import type {
  LoadedSkill,
  Skill,
  SkillFileStore,
  SkillInput,
  SkillPatch,
  SkillProblem,
  SkillScan,
} from "./skill-types";

/**
 * エージェントが作ったスキルの置き場。
 *
 * スキルは Agent Skills の標準に合わせて、コンテナのホームの中の
 * `.agents/skills/<name>/SKILL.md` に置く。ホスト側では
 * `dataDir/container/home/.agents/skills/<name>/SKILL.md` になる。
 * コンテナが動いていなくても読めるよう、アプリはホスト側のパスを直接読み書きする。
 *
 * 置き場を読むときは寛容にする。第三者が置いたスキルの YAML が壊れていても、
 * アプリ全体を止めず、そのスキルだけ読み飛ばして理由を返す。
 */

/** SKILL.md のファイル名。 */
const SKILL_FILE_NAME = "SKILL.md";
/** 書き込みの途中で残らないよう、SKILL.md の隣に作る一時ファイルの接頭辞。 */
const TEMP_SKILL_FILE_PREFIX = `.${SKILL_FILE_NAME}.`;
/** コンテナのホームの中の、スキルの置き場。 */
const SKILLS_DIR_NAME = join(".agents", "skills");
/** 1 回の走査で読むスキルの上限。 */
const MAX_SKILLS = 200;
/** スキル名の長さの上限。 */
const MAX_NAME_CHARS = 64;
/** 説明の長さの上限。 */
const MAX_DESCRIPTION_CHARS = 1024;
/** 本文の長さの上限。 */
const MAX_CONTENT_CHARS = 50_000;
/** Agent Skills のスキル名。先頭と末尾のハイフン、連続するハイフンを許さない。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Windows と Linux のどちらでも 1 つのパス要素として安全な名前。 */
const UNSAFE_NAME = /[<>:"/\\|?*]/;

export function createSkillFileStore(options: { dataDir: string }): SkillFileStore {
  const skillsDir = join(containerHomeDir(options.dataDir), SKILLS_DIR_NAME);

  return {
    scan() {
      return scanSkills(skillsDir);
    },
    get(name) {
      return readLoadedSkill(skillsDir, name);
    },
    create(input) {
      return createSkill(skillsDir, input);
    },
    update(name, patch) {
      return updateSkill(skillsDir, name, patch);
    },
    delete(name) {
      return deleteSkill(skillsDir, name);
    },
  };
}

/** 置き場の直下を走査し、読めたスキルと読めなかった理由を返す。 */
function scanSkills(skillsDir: string): SkillScan {
  const directoryProblem = skillsDirProblem(skillsDir);
  if (directoryProblem !== null) {
    return { skills: [], problems: [{ name: "(skills directory)", reason: directoryProblem }] };
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { skills: [], problems: [] };
    throw error;
  }

  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const skills: Skill[] = [];
  const problems: SkillProblem[] = [];

  for (const name of names.slice(0, MAX_SKILLS)) {
    if (!isSafeSkillDirName(name)) {
      problems.push({ name, reason: "the directory name is not a safe path segment" });
      continue;
    }

    const result = readSkillFile(join(skillsDir, name), name);
    if (result.kind === "missing") continue;
    if (result.kind === "problem") {
      problems.push({ name, reason: result.reason });
      continue;
    }
    skills.push(result.skill);
  }

  if (names.length > MAX_SKILLS) {
    problems.push({
      name: "(skills directory)",
      reason: `There are ${names.length} skill directories; only the first ${MAX_SKILLS} are loaded.`,
    });
  }

  return { skills, problems };
}

/** 1 件のスキルを、本文とディレクトリと同梱ファイルまで読む。 */
function readLoadedSkill(skillsDir: string, name: string): LoadedSkill | null {
  if (!isSafeSkillDirName(name)) return null;
  if (skillsDirProblem(skillsDir) !== null) return null;

  const dir = join(skillsDir, name);
  const info = lstatSync(dir, { throwIfNoEntry: false });
  if (info === undefined || !info.isDirectory()) return null;

  const result = readSkillFile(dir, name);
  if (result.kind !== "skill") return null;

  const resources = listSkillResources(dir);
  return {
    ...result.skill,
    dir: posix.join(SKILLS_DIR_IN_CONTAINER, name),
    resources: resources.files,
    resourcesTruncated: resources.truncated,
  };
}

type ReadResult = { kind: "missing" } | { kind: "problem"; reason: string } | { kind: "skill"; skill: Skill };

/** SKILL.md を読み、frontmatter と本文を分ける。 */
function readSkillFile(dir: string, name: string): ReadResult {
  const path = join(dir, SKILL_FILE_NAME);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) return { kind: "missing" };
  if (!info.isFile()) return { kind: "problem", reason: `${SKILL_FILE_NAME} is not a regular file` };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { kind: "problem", reason: `cannot read ${SKILL_FILE_NAME}: ${describeError(error)}` };
  }

  const parsed = readFrontmatter(text, SKILL_FILE_NAME);
  if (parsed.kind === "problem") return parsed;
  const { data, body } = parsed;

  const rawDescription = data["description"];
  if (typeof rawDescription !== "string" || rawDescription.trim().length === 0) {
    return { kind: "problem", reason: "frontmatter has no description" };
  }
  if (rawDescription.length > MAX_DESCRIPTION_CHARS) {
    console.warn(`[skills] ${name}: description is longer than ${MAX_DESCRIPTION_CHARS} characters`);
  }

  const rawName = data["name"];
  if (typeof rawName !== "string" || rawName !== name) {
    console.warn(`[skills] ${name}: frontmatter name does not match the directory; using the directory name`);
  }

  return {
    kind: "skill",
    skill: {
      name,
      description: oneLine(rawDescription),
      content: body,
    },
  };
}

/** 新しいスキルを作る。 */
function createSkill(skillsDir: string, input: SkillInput): LoadedSkill {
  const name = normalizeName(input.name);
  const description = normalizeDescription(input.description);
  const content = normalizeContent(input.content);
  const dir = join(skillsDir, name);

  const directoryProblem = skillsDirProblem(skillsDir);
  if (directoryProblem !== null) throw new Error(`Cannot create a skill: ${directoryProblem}.`);

  if (existsSync(dir)) {
    throw new Error(
      `The directory ${posix.join(SKILLS_DIR_IN_CONTAINER, name)} already exists. Choose another name or remove it first.`,
    );
  }

  mkdirSync(dir, { recursive: true });
  try {
    writeSkillFile(dir, { name, description }, content);
  } catch (error) {
    // 作れなかったディレクトリを残すと、同じ名前で作り直せなくなる。
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 片付けにも失敗したときは、元の失敗を返す。
    }
    throw error;
  }

  const loaded = readLoadedSkill(skillsDir, name);
  if (loaded === null) throw new Error(`Skill "${name}" was written but could not be read back.`);
  return loaded;
}

/** 説明か本文を書き換える。任意の frontmatter は残す。 */
function updateSkill(skillsDir: string, name: string, patch: SkillPatch): LoadedSkill {
  if (!isSafeSkillDirName(name)) throw new Error(`Invalid skill name "${name}".`);
  if (patch.description === undefined && patch.content === undefined) {
    throw new Error('action "update" needs description or content.');
  }

  const directoryProblem = skillsDirProblem(skillsDir);
  if (directoryProblem !== null) throw new Error(`Cannot update a skill: ${directoryProblem}.`);

  const dir = join(skillsDir, name);
  if (!isDirectory(dir)) {
    throw new Error(`No skill named "${name}" was created. Use action "list" to see your skills.`);
  }

  const path = join(dir, SKILL_FILE_NAME);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) {
    throw new Error(`No skill named "${name}" was created. Use action "list" to see your skills.`);
  }
  if (!info.isFile()) {
    throw new Error(`Skill "${name}" has a ${SKILL_FILE_NAME} that is not a regular file. Replace it with write.`);
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${name}/${SKILL_FILE_NAME}: ${describeError(error)}`, { cause: error });
  }

  const parsed = readFrontmatter(text, SKILL_FILE_NAME);
  if (parsed.kind === "problem") {
    throw new Error(`Skill "${name}": ${parsed.reason}. Use write to repair ${SKILL_FILE_NAME}.`);
  }
  const { data, body } = parsed;

  if (patch.description === undefined) {
    const current = data["description"];
    if (typeof current !== "string" || current.trim().length === 0) {
      throw new Error(`Skill "${name}" has no description. Use write to repair ${SKILL_FILE_NAME}.`);
    }
  } else {
    data["description"] = normalizeDescription(patch.description);
  }

  const content = patch.content === undefined ? body : normalizeContent(patch.content);
  data["name"] = name;

  writeSkillFile(dir, data, content);

  const loaded = readLoadedSkill(skillsDir, name);
  if (loaded === null) throw new Error(`Skill "${name}" was written but could not be read back.`);
  return loaded;
}

/** スキルのディレクトリごと消す。 */
function deleteSkill(skillsDir: string, name: string): boolean {
  if (!isSafeSkillDirName(name)) return false;

  const directoryProblem = skillsDirProblem(skillsDir);
  if (directoryProblem !== null) throw new Error(`Cannot delete a skill: ${directoryProblem}.`);

  const dir = join(skillsDir, name);
  if (!isDirectory(dir)) return false;

  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * frontmatter の並びを、読みやすいブロック形式で書く。
 * 本文は 1 つの改行で区切る。
 */
function writeSkillFile(dir: string, frontmatter: Record<string, unknown>, content: string): void {
  const text = formatSkillFile(frontmatter, content);
  const target = join(dir, SKILL_FILE_NAME);
  const temporary = join(dir, `${TEMP_SKILL_FILE_PREFIX}${randomUUID()}.tmp`);

  // wx で新しく作る。既にある名前（シンボリックリンクを含む）は追わない。
  writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, target);
}

/** スキル名を検証する。先頭と末尾の空白は落とす。 */
function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_NAME_CHARS) {
    throw new Error(`Skill name must be 1-${MAX_NAME_CHARS} characters.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Skill name "${name}" is invalid. Use lowercase letters, digits and single hyphens; do not start or end with a hyphen.`,
    );
  }
  return name;
}

/** 説明を検証する。改行は許し、YAML へ書くときに引用する。 */
function normalizeDescription(value: string): string {
  const description = value.trim();
  if (description.length === 0) throw new Error("Skill description must not be empty.");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(`Skill description must be at most ${MAX_DESCRIPTION_CHARS} characters.`);
  }
  return description;
}

/** 本文を検証する。 */
function normalizeContent(value: string): string {
  const content = value.trim();
  if (content.length === 0) throw new Error("Skill content must not be empty.");
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(`Skill content must be at most ${MAX_CONTENT_CHARS} characters.`);
  }
  return content;
}

/** 1 つのパス要素として安全な名前かどうか。 */
function isSafeSkillDirName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("\0") && !UNSAFE_NAME.test(name);
}

/** ディレクトリそのものかどうか。シンボリックリンクは含めない。 */
function isDirectory(path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info?.isDirectory() === true;
}

/**
 * 置き場が通常のディレクトリかどうか。シンボリックリンクは認めない。
 * コンテナの中のエージェントが .agents や skills を外へ向けるリンクに置き換えても、
 * ホスト側の読み書きがその先へ出ないようにする。
 */
function skillsDirProblem(skillsDir: string): string | null {
  const agentsDir = dirname(skillsDir);
  const agents = lstatSync(agentsDir, { throwIfNoEntry: false });
  if (agents !== undefined && !agents.isDirectory()) {
    return "the .agents directory is not a regular directory";
  }

  const skills = lstatSync(skillsDir, { throwIfNoEntry: false });
  if (skills !== undefined && !skills.isDirectory()) {
    return "the skills directory is not a regular directory";
  }

  return null;
}

/** 存在しないパスを表す失敗かどうか。 */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
