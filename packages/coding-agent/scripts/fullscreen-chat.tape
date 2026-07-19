Output "/tmp/omp-fullscreen-chat.gif"
Set Shell "bash"
Set Width 1200
Set Height 720
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 15
Set Padding 0
Set Framerate 10

Hide
Type "bun scripts/fullscreen-chat-screenshot-fixture.ts initial"
Enter
Sleep 0.5s
Show
Screenshot "/tmp/omp-fullscreen-chat-initial.png"
Sleep 1.6s
Hide
Type "bun scripts/fullscreen-chat-screenshot-fixture.ts scrolled"
Enter
Sleep 0.5s
Show
Screenshot "/tmp/omp-fullscreen-chat-scrolled.png"
Sleep 1.6s
Hide
Type "bun scripts/fullscreen-chat-screenshot-fixture.ts anchored"
Enter
Sleep 0.5s
Show
Screenshot "/tmp/omp-fullscreen-chat-anchored.png"
