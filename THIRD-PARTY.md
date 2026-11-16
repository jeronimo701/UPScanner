# Сторонние компоненты

Версии установленной среды и первичные сайты поставщиков перечислены в SOURCES.json. Исходные тексты доступных notices/лицензий из metadata пакетов скопированы в publication-notices/. Они включаются внутрь EXE и поставляются отдельно. Python и библиотеки не перелицензируются лицензией Jeronimo701.

Python: https://www.python.org/ . PyInstaller: https://pyinstaller.org/ (bootloader имеет собственные условия и исключение для распространяемых приложений). Сборочная среда и бинарные зависимости не входят в Git как новый авторский код.

Приложения используют системные шрифты Windows. Шрифты, скопированные из Windows, не распространяются. При запуске на другой ОС/без соответствующих шрифтов оформление PDF требует отдельной проверки.

Android использует [AndroidX](https://github.com/androidx/androidx), [ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded), [PDFBox-Android](https://github.com/TomRoush/PdfBox-Android) и [JExcelAPI](https://jexcelapi.sourceforge.net/). Версии указаны в android/build.gradle. Эти компоненты и Gradle Wrapper сохраняют условия своих правообладателей.
