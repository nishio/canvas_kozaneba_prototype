#!/usr/bin/env python3
import json
import numpy as np
import matplotlib.pyplot as plt
from scipy.stats import gaussian_kde
from matplotlib.colors import LinearSegmentedColormap
import japanize_matplotlib


def load_data(file_path):
    """JSONファイルからx, y座標を読み込む"""
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    x_coords = []
    y_coords = []

    for arg in data["arguments"]:
        x_coords.append(arg["x"])
        y_coords.append(arg["y"])

    return np.array(x_coords), np.array(y_coords)


def create_kde_contour_map(x, y, resolution=200, bandwidth=0.3):
    """KDEを使用してContour Mapを作成"""
    # KDEオブジェクトを作成
    xy = np.vstack([x, y])
    kde = gaussian_kde(xy)
    kde.set_bandwidth(bandwidth)

    # グリッドを作成
    x_min, x_max = x.min() - 1, x.max() + 1
    y_min, y_max = y.min() - 1, y.max() + 1

    xx, yy = np.mgrid[x_min : x_max : resolution * 1j, y_min : y_max : resolution * 1j]
    positions = np.vstack([xx.ravel(), yy.ravel()])

    # 密度を計算
    density = np.reshape(kde(positions).T, xx.shape)

    return xx, yy, density


def visualize_kde_contour(xx, yy, density):
    """KDE Contour Mapを可視化"""
    plt.figure(figsize=(12, 8))

    # カスタムカラーマップを作成（青から赤へのグラデーション）
    colors = ["#000080", "#0000FF", "#00FFFF", "#00FF00", "#FFFF00", "#FF0000"]
    n_bins = 100
    cmap = LinearSegmentedColormap.from_list("density", colors, N=n_bins)

    # コンターマップを描画
    contour_filled = plt.contourf(xx, yy, density, levels=20, cmap=cmap, alpha=0.7)
    contour_lines = plt.contour(
        xx, yy, density, levels=10, colors="black", alpha=0.3, linewidths=0.5
    )

    # カラーバーを追加
    cbar = plt.colorbar(contour_filled, shrink=0.8)
    cbar.set_label("密度", rotation=270, labelpad=15, fontsize=12)

    # グラフの装飾
    plt.xlabel("X座標", fontsize=12)
    plt.ylabel("Y座標", fontsize=12)
    plt.title("引数分布の密度推定 (KDE Contour Map)", fontsize=14, fontweight="bold")
    plt.grid(True, alpha=0.3)

    # アスペクト比を調整
    plt.gca().set_aspect("equal", adjustable="box")

    plt.tight_layout()
    return plt


def main():
    # データを読み込み
    print("データを読み込み中...")
    x, y = load_data("hierarchical_result.json")
    print(f"データポイント数: {len(x)}")

    # KDE Contour Mapを作成
    print("KDE密度推定を実行中...")
    xx, yy, density = create_kde_contour_map(x, y, resolution=800, bandwidth=0.05)
    # xx, yy, density = create_kde_contour_map(x, y, resolution=400, bandwidth=0.1)

    # 可視化
    print("可視化を作成中...")
    plt = visualize_kde_contour(xx, -yy, density)

    # 保存
    output_file = "kde_contour_map.png"
    plt.savefig(output_file, dpi=300, bbox_inches="tight")
    print(f"可視化結果を {output_file} に保存しました")

    # 表示
    plt.show()


if __name__ == "__main__":
    main()
