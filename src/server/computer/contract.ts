/**
 * コンテナの契約値。
 *
 * この値は container/desktop.Containerfile と container/entry.sh にも書かれている。
 * 起動時に実際のコンテナの値と突き合わせ、ずれていれば起動失敗として理由を出す
 * （ずれたまま動くと、画面の中継やマウントの権限だけが静かに壊れる）。
 */

/** エージェントが作業する場所。ホストのデータディレクトリの下がマウントされる。 */
export const WORKDIR_IN_CONTAINER = "/home/agent";

/** コンテナの中で noVNC が待ち受けているポート。 */
export const VNC_PORT_IN_CONTAINER = 6080;

/** コンテナの中の uid / gid。Containerfile が作る agent ユーザーに合わせる。 */
export const CONTAINER_UID = 1000;
export const CONTAINER_GID = 1000;

/** Xvfb と x11vnc が使う仮想ディスプレイ。 */
export const CONTAINER_DISPLAY = ":99";
