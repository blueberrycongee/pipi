import { mount } from "nsh";
import { Scrollbar } from "nsh/base";
import { boot } from "./store/app";
import { Shell } from "./views/Shell";

// One scroll bar for every scroll view and list: none. The app's bar draws
// nothing — hidden, it takes no presses — so no surface shows an indicator.
Scrollbar.setTheme({
  vertical: { class: "absolute inset-y-0 right-0 w-3 opacity-0" },
  horizontal: { class: "absolute inset-x-0 bottom-0 h-3 opacity-0" },
});

void boot();
mount(Shell);
