import { mount, Text, View } from "nsh";
import { Pip, type Mood } from "./mascot/Pip";
import { AgentLogo, type AgentLogoId } from "./ui/AgentLogo";
import { Icon, type IconName } from "./ui/Icon";

const MOODS: Mood[] = ["idle", "think", "work", "write", "happy", "error", "sleep"];
const AGENTS: AgentLogoId[] = ["pi","claude","codex","devin","opencode","cursor","gemini","copilot","grok","goose","kimi","qwen","dsh","antigravity","hermes","kiro","droid","amp"];
const ICONS: IconName[] = ["plus","x","check","chevronDown","chevronRight","chevronsUpDown","arrowUp","arrowLeft","stop","search","folder","folderOpen","folderPlus","archive","unarchive","trash","pencil","copy","terminal","file","fileEdit","filePlus","sliders","gear","github","more","alert","info","refresh","sidebar","sparkle","bolt","chip","key","external","download","fork","compact","image","enter","clock","eye","plug","message","command","steer","queue","dot","globe","wrench","agents","layers","shield","shieldLock","shieldHalf","shieldBolt"];

mount(() => (
  <View class="flex-1 gap-6 bg-background p-8">
    <View class="flex-row items-end gap-8">
      <Each of={MOODS}>{(m) => (
        <View class="items-center gap-2"><Pip size={72} mood={m()} /><Text class="text-xs text-muted-foreground">{m()}</Text></View>
      )}</Each>
    </View>
    <View class="flex-row items-end gap-6">
      <Pip size={16} still /><Pip size={20} still /><Pip size={24} still /><Pip size={32} still /><Pip size={48} still /><Pip size={128} />
    </View>
    <View class="flex-row flex-wrap gap-3">
      <Each of={ICONS}>{(n) => (
        <View class="size-8 items-center justify-center rounded-md bg-card"><Icon name={n()} tone="foreground" /></View>
      )}</Each>
    </View>
    <View class="flex-row flex-wrap gap-3">
      <Each of={ICONS}>{(n) => <Icon name={n()} size={32} tone="muted-foreground" />}</Each>
    </View>
    <View class="flex-row flex-wrap items-end gap-4">
      <Each of={AGENTS}>{(id) => (
        <View class="items-center gap-2">
          <AgentLogo id={id()} size={40} status="ready" />
          <AgentLogo id={id()} size={14} />
          <Text class="text-xs text-muted-foreground">{id()}</Text>
        </View>
      )}</Each>
    </View>
  </View>
));
