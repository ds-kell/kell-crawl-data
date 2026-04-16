import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

def get_filtered_urls_from_page(url, keyword):
    try:
        # Gửi yêu cầu GET đến URL
        response = requests.get(url)
        response.raise_for_status()  # Kiểm tra nếu yêu cầu thành công

        # Phân tích HTML của trang bằng BeautifulSoup
        soup = BeautifulSoup(response.content, 'html.parser')

        # Tìm tất cả các thẻ <a> (liên kết) trên trang
        a_tags = soup.find_all('a')

        # Trích xuất href từ mỗi thẻ <a> và chuẩn hóa thành URL đầy đủ
        urls = [urljoin(url, a.get('href')) for a in a_tags if a.get('href') and keyword in a.get('href')]

        return urls

    except requests.exceptions.RequestException as e:
        print(f"Error fetching the page: {e}")
        return []

def save_urls_to_file(urls, filename):
    with open(filename, 'w') as file:
        for url in urls:
            file.write(url + '\n')
    print(f"Saved {len(urls)} URLs to {filename}")

# URL của trang mà bạn muốn lấy tất cả các URL
url = "https://e-hentai.org/g/2860294/391a4d6c5b/"

# Từ khóa để lọc các URL
keyword = "https://e-hentai.org/s/"

# Lấy các URL đã lọc từ trang
filtered_urls = get_filtered_urls_from_page(url, keyword)

# Lưu các URL đã lọc vào file
save_urls_to_file(filtered_urls, 'targets_urls.txt')

# In ra các URL đã lưu (tùy chọn)
for i, link in enumerate(filtered_urls, start=1):
    print(f"URL {i}: {link}")
