/** Fixed Minecraft Java 1.20.4 pack. Only init builds the test pad; model actions change one block. */
export function minecraftDatapack(world: number): Record<string, string> {
  if (!Number.isSafeInteger(world) || world < 1 || world > 2_000_000_000) throw new Error("Invalid world identity.");
  const files: Record<string, string> = {
    "pack.mcmeta": JSON.stringify({ pack: { pack_format: 26, description: "Xiaoqie one-block playtest (Java 1.20.4)" } }),
    "data/minecraft/tags/functions/load.json": JSON.stringify({ values: ["xqb:load"] }),
    "data/xqb/functions/load.mcfunction": "execute unless data storage xqb:state state run function xqb:init\n",
    "data/xqb/functions/init.mcfunction": [
      "scoreboard objectives add xqb dummy",
      "scoreboard players set #last xqb 0",
      "execute in minecraft:overworld run forceload add -16 -16 0 0",
      // Chunk loading is asynchronous at first boot. Initialization is completed on a later tick.
      "schedule function xqb:build_pad 2s replace",
    ].join("\n") + "\n",
    "data/xqb/functions/build_pad.mcfunction": [
      "schedule function xqb:build_pad 1s replace",
      "execute in minecraft:overworld if loaded -3 80 -3 if loaded -3 80 3 if loaded 3 80 -3 if loaded 3 80 3 run function xqb:ready_pad",
    ].join("\n") + "\n",
    "data/xqb/functions/ready_pad.mcfunction": [
      "schedule clear xqb:build_pad",
      "execute if data storage xqb:state state run return 0",
      "execute in minecraft:overworld run fill -3 80 -3 3 80 3 minecraft:smooth_stone",
      "execute in minecraft:overworld run setblock 0 81 0 minecraft:white_wool",
      "execute in minecraft:overworld run setworldspawn 2 81 2",
      "gamerule spawnRadius 0",
      `data modify storage xqb:state state set value {world:${world},revision:0,last:0,status:0,color:0}`,
    ].join("\n") + "\n",
  };
  const fence = [
    "$execute unless data storage xqb:state {state:{world:$(world)}} run return 0",
    "$execute if score #last xqb matches $(sequence).. run return 0",
    "$scoreboard players set #last xqb $(sequence)",
    "$data modify storage xqb:state state.last set value $(sequence)",
    "data modify storage xqb:state state.status set value -1",
  ];
  files["data/xqb/functions/reconcile.mcfunction"] = fence.join("\n") + "\n";
  const blocks = ["white_wool", "lime_wool", "gold_block", "blue_wool"];
  for (const [index, color] of ["lime", "gold", "blue"].entries()) {
    files[`data/xqb/functions/set_${color}.mcfunction`] = [
      ...fence,
      "$execute unless data storage xqb:state {state:{revision:$(expected)}} run return 0",
      ...blocks.map((block, i) => `execute if data storage xqb:state {state:{color:${i}}} in minecraft:overworld unless block 0 81 0 minecraft:${block} run return 0`),
      `execute in minecraft:overworld run setblock 0 81 0 minecraft:${blocks[index + 1]}`,
      `execute in minecraft:overworld unless block 0 81 0 minecraft:${blocks[index + 1]} run return 0`,
      `$data modify storage xqb:state state.revision set value $(next)`,
      `data modify storage xqb:state state.color set value ${index + 1}`,
      "data modify storage xqb:state state.status set value 1",
    ].join("\n") + "\n";
  }
  return files;
}
