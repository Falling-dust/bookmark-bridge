# Install Bookmark Bridge

1. Download the extension ZIP from the [latest release](https://github.com/Falling-dust/bookmark-bridge/releases/latest). Extract the `bookmark-bridge` folder to a location where you can keep it.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Turn on **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`. If you have a source checkout, select the project folder.
4. Open the browser’s Extensions menu and select **Bookmark Bridge**. Repeat these steps on the other computer.

Use a current Chrome or Edge release. The extension requests `bookmarks` and `storage` permissions and processes transfers locally. Your browser’s bookmark sync settings still apply.

## Update an existing installation

Replace the files in the same extension folder and click **Reload** on the extensions page. Keeping the same folder and browser profile retains your import history. Uninstalling the extension or clearing its data deletes that history.

## Transfer bookmarks

On the first computer, open **Export bookmarks**, select and order the items, and save them as HTML or JSON. Copy that file to the other computer. Open **Import bookmarks**, choose the file, set the destinations, and review the changes before applying them. The [user guide](https://github.com/Falling-dust/bookmark-bridge#transfer-bookmarks) covers duplicate choices, file formats, and undo.
