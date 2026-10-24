/**
 * @novnc/novnc は型を持たないので、使う分だけの形を宣言する。
 * 実際の型は ComputerPane.tsx の RfbClient / RfbConstructor が持つ。
 */
declare module "@novnc/novnc" {
  const RFB: unknown;
  export default RFB;
}
