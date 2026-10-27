/**
 * スキルの型。
 *
 * スキルは Agent Skills の標準に合わせて、名前、説明、本文を持つ。
 * ファイルから読んだスキルは、本文に加えて、置き場のディレクトリと同梱ファイルを持つ。
 */

/** 一覧に載せられるスキル。 */
export type Skill = {
  /** スキルの名前。ディレクトリ名と一致する。 */
  name: string;
  /** 一覧に載せる 1 行の説明。 */
  description: string;
  /** SKILL.md の本文（frontmatter を除く）。 */
  content: string;
};

/** 本文を読み込んだスキル。 */
export type LoadedSkill = Skill & {
  /** コンテナ内のスキルディレクトリ。組み込みスキルは null。 */
  dir: string | null;
  /** スキルディレクトリからの相対パス。 */
  resources: readonly string[];
  /** 同梱ファイルの一覧を上限で切ったかどうか。 */
  resourcesTruncated: boolean;
};

/** 新しいスキルを作る入力。 */
export type SkillInput = {
  name: string;
  description: string;
  content: string;
};

/** 既存のスキルを書き換える入力。少なくとも 1 つは指定する。 */
export type SkillPatch = {
  description?: string;
  content?: string;
};

/** 読み込めなかったスキルディレクトリ。 */
export type SkillProblem = {
  /** ディレクトリ名。 */
  name: string;
  /** 読み込めなかった理由。 */
  reason: string;
};

/** 置き場を走査した結果。 */
export type SkillScan = {
  skills: readonly Skill[];
  problems: readonly SkillProblem[];
};

/** スキルのファイルを読み書きするストア。 */
export type SkillFileStore = {
  /** 標準の置き場を走査する（本文も読む）。 */
  scan(): SkillScan;
  /**
   * 名前と説明だけを走査する。本文は空になる。
   * system プロンプトの一覧は、これで足りる（本文は skill ツールで読んだときだけ要る）。
   */
  scanCatalog(): SkillScan;
  /** 名前で 1 件読む。無ければ null。 */
  get(name: string): LoadedSkill | null;
  /** 新しいスキルを作る。 */
  create(input: SkillInput): LoadedSkill;
  /** 説明か本文を書き換える。 */
  update(name: string, patch: SkillPatch): LoadedSkill;
  /** ディレクトリごと消す。無ければ false。 */
  delete(name: string): boolean;
};

/** 組み込みとファイルのスキルをまとめたもの。 */
export type SkillLibrary = {
  /** すべてのスキル。 */
  all(): readonly Skill[];
  /** 名前で 1 件読む。 */
  get(name: string): LoadedSkill | undefined;
  /** 組み込みスキルかどうか。 */
  isBuiltin(name: string): boolean;
};
