import { mount } from "nsh";
import { Scrollbar } from "nsh/base";
import { boot } from "./store/app";
import { Shell } from "./views/Shell";

// One scroll bar for every scroll view and list: a thin pill that shows while scrolling or under the pointer.
Scrollbar.setTheme({
  mode: "hover",
  motion: { enter: 120, exit: 400 },
  vertical: {
    class: "absolute inset-y-0 right-0 w-3 items-end p-0.5",
    thumbClass: "w-1.5 rounded-full bg-muted-foreground opacity-40 transition-all duration-150 hover:opacity-70 active:opacity-80",
  },
  horizontal: {
    class: "absolute inset-x-0 bottom-0 h-3 justify-end p-0.5",
    thumbClass: "h-1.5 rounded-full bg-muted-foreground opacity-40 transition-all duration-150 hover:opacity-70 active:opacity-80",
  },
});

void boot();
mount(Shell);
