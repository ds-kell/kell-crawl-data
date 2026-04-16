import json
import os
import time
import requests
from selenium import webdriver
from selenium.webdriver.common.by import By

# Đã tải genko_photo_2\genko1458.jpg

# === CẤU HÌNH ===
URL_FILE = "failed_urls.jsonl"  # Đổi sang file chứa URL lỗi
SAVE_FOLDER = "genko_photos_7"
FILENAME_PREFIX = "genko_photo_"
SUCCESS_URLS_FILE = "success_urls.jsonl"
FAILED_URLS_FILE = "failed_urls_retry.jsonl"  # Tạo file mới để tránh ghi đè file cũ

# === KHỞI TẠO TRÌNH DUYỆT ===
driver = webdriver.Chrome()
driver.get("https://www.facebook.com/login/")
time.sleep(5)

# === ĐĂNG NHẬP FACEBOOK ===
username = 'nguyentruyen103dc@gmail.com'
password = 'longngaokieu'
# username = 'demonslayerpl@gmail.com'
# password = 'longngaothien'
driver.find_element(By.ID, 'email').send_keys(username)
driver.find_element(By.ID, 'pass').send_keys(password)
driver.find_element(By.NAME, 'login').click()
time.sleep(30)

# === ĐỌC FILE JSONL (failed_urls.jsonl) ===
if not os.path.exists(URL_FILE):
    print(f"Không tìm thấy file {URL_FILE}")
    driver.quit()
    exit()

photo_urls = []
with open(URL_FILE, "r", encoding="utf-8") as file:
    for line in file:
        photo_urls.append(json.loads(line.strip()))  # Đọc từng dòng JSON

# === TẠO THƯ MỤC LƯU ẢNH ===
if not os.path.exists(SAVE_FOLDER):
    os.makedirs(SAVE_FOLDER)

print('----------------RETRY DOWNLOAD FAILED IMAGES----------------')

# === HÀM GHI JSON THEO TỪNG DÒNG ===
def append_to_jsonl(file_path, data):
    """ Ghi từng object JSON trên 1 dòng """
    with open(file_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False) + "\n")


# === VÒNG LẶP TẢI ẢNH ===
for item in photo_urls:
    try:
        index = item["index"]
        photo_url = item["value"]

        driver.get(photo_url)
        time.sleep(10)

        # Tìm ảnh gốc
        image_elements = driver.find_elements(By.XPATH, "//img[contains(@src, 'scontent') and contains(@src, 'fbcdn.net')]")
        if not image_elements:
            print(f"Không tìm thấy ảnh tại {photo_url}")
            append_to_jsonl(FAILED_URLS_FILE, {"index": index, "value": photo_url})
            continue

        img_url = image_elements[0].get_attribute('src')

        # Xác định định dạng ảnh
        ext = "png" if ".png" in img_url else "jpg"

        # Tạo đường dẫn file
        file_path = os.path.join(SAVE_FOLDER, f"{FILENAME_PREFIX}{index}.{ext}")

        # Tải ảnh
        img_data = requests.get(img_url).content
        with open(file_path, 'wb') as img_file:
            img_file.write(img_data)

        print(f'Đã tải {file_path}')
        append_to_jsonl(SUCCESS_URLS_FILE, {"index": index, "value": photo_url})

    except Exception as e:
        print(f'Lỗi khi tải ảnh từ {photo_url}: {e}')
        append_to_jsonl(FAILED_URLS_FILE, {"index": index, "value": photo_url, "error": str(e)})

print("Hoàn thành tải lại ảnh lỗi!")
driver.quit()
