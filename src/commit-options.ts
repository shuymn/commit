export type CommitLanguage = "english" | "japanese";

export type CommitOptions = {
  readonly language?: CommitLanguage;
  readonly branch: boolean;
  readonly base?: string;
};
